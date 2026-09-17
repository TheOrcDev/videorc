import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  packagedAppPayloadIdentity,
  packagedAppPayloadManifestSha256,
  WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS
} from './performance-contract.mjs'
import { sha256File } from './windows-alpha-release.mjs'
import { WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS } from './windows-d3d11-media.mjs'
import { assertPendingWindowsCandidateManifest } from './windows-release-candidate.mjs'

export const WINDOWS_LOCAL_GATE_MANIFEST_NAME = 'windows-local-gates.manifest.json'
export const WINDOWS_POST_BUILD_ALLOWED_GIT_PATHS = Object.freeze([
  'docs/adr/0001-obs-parity-native-capture-architecture.md',
  'docs/windows-port-plan.md',
  'docs/windows-dev-loop.md',
  'docs/acceptance/windows-app-acceptance-template.md',
  'docs/acceptance/windows-d3d11-performance-budget.json',
  'docs/acceptance/2026-07-30-windows-d3d11-media.md',
  'plans/040-windows-d3d11-shared-texture-media-path.md',
  'plans/README.md'
])
const WINDOWS_PACKAGED_APP_PAYLOAD_SPECS = WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.map(
  (relativePath) => ({ relativePath, requiresCodeSignature: false })
)
const WINDOWS_BUNDLED_7ZIP_VERSION = '5.2.0'
const WINDOWS_BUNDLED_7ZIP_X64_SIZE_BYTES = 1_231_360
const WINDOWS_BUNDLED_7ZIP_X64_SHA256 =
  'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95'
const WINDOWS_ARCHIVE_MAX_ENTRIES = 20_000
const WINDOWS_ARCHIVE_MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024

export function evaluateWindowsLocalGateHost({
  platform = process.platform,
  arch = process.arch,
  release = '',
  allowUnsupportedBuild = false,
  requireKnownBuild = false
} = {}) {
  const failures = []
  if (platform !== 'win32') {
    failures.push(`requires Windows 11 x64; current platform is ${platform}`)
  }
  if (arch !== 'x64') {
    failures.push(`requires x64 architecture; current architecture is ${arch}`)
  }

  const build = windowsBuildNumber(release)
  if (platform === 'win32' && build === null && requireKnownBuild) {
    failures.push('requires a parseable Windows build number for release acceptance')
  }
  if (platform === 'win32' && build !== null && build < 22000 && !allowUnsupportedBuild) {
    failures.push(`requires Windows 11 build 22000 or newer; current build is ${build}`)
  }

  return {
    ok: failures.length === 0,
    failures,
    build
  }
}

export function sanitizeWindowsLocalGateChildEnvironment(env) {
  const sanitized = { ...env }
  const sensitiveName =
    /^(?:AZURE_|APPLE_|CSC_|WIN_CSC_|VIDEORC_(?:DOWNLOAD|RELEASE_UPLOAD)_S3_|VIDEORC_WINDOWS_(?:SIGNING_|PILOT_UPDATE_TOKEN$))/
  for (const name of Object.keys(sanitized)) {
    if (
      sensitiveName.test(name) ||
      /^VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_(?:APP|PAYLOAD)_SHA256$/.test(name) ||
      WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS.includes(name)
    ) {
      delete sanitized[name]
    }
  }
  return sanitized
}

export function assertWindowsCandidatePayloadIdentity(packagePayload) {
  if (
    packagePayload?.algorithm !== 'sha256-packaged-code-manifest-v1' ||
    !lowercaseSha256(packagePayload?.sha256)
  ) {
    throw new Error(
      'Installed candidate packaged-app payload did not produce a valid lowercase SHA-256 identity.'
    )
  }
  if (
    !Array.isArray(packagePayload.components) ||
    packagePayload.components.length !== WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.length
  ) {
    throw new Error('Installed candidate packaged-app payload did not contain every required file.')
  }
  for (const [index, relativePath] of WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.entries()) {
    const component = packagePayload.components[index]
    if (
      component?.relativePath !== relativePath ||
      component?.identityKind !== 'sha256' ||
      !lowercaseSha256(component?.sha256) ||
      component.identity !== component.sha256
    ) {
      throw new Error(
        `Installed candidate packaged-app payload identity was invalid for ${relativePath}.`
      )
    }
  }
  if (
    !Array.isArray(packagePayload.unsignedComponents) ||
    packagePayload.unsignedComponents.length !== 0
  ) {
    throw new Error('Installed candidate packaged-app payload identity was incomplete.')
  }
  const canonicalSha256 = packagedAppPayloadManifestSha256(packagePayload.components, {
    payloadSpecs: WINDOWS_PACKAGED_APP_PAYLOAD_SPECS
  })
  if (canonicalSha256 !== packagePayload.sha256) {
    throw new Error(
      'Installed candidate packaged-app payload SHA-256 did not match its canonical component manifest.'
    )
  }
  return packagePayload
}

export function assertWindowsCandidatePayloadsIdentical(expected, actual, label = 'candidate') {
  const expectedPayload = assertWindowsCandidatePayloadIdentity(expected)
  const actualPayload = assertWindowsCandidatePayloadIdentity(actual)
  if (
    expectedPayload.sha256 !== actualPayload.sha256 ||
    JSON.stringify(expectedPayload.components) !== JSON.stringify(actualPayload.components)
  ) {
    throw new Error(`${label} packaged payload bytes did not match component-for-component`)
  }
  return expectedPayload
}

export async function assertWindowsPackagedPayloadPaths(
  executablePath,
  { platform = process.platform, inspectArtifactPath = assertWindowsCandidateArtifactPath } = {}
) {
  if (!isAbsolute(executablePath ?? '')) {
    throw new Error('packaged Windows executable path must be absolute')
  }
  const payloadRoot = dirname(resolve(executablePath))
  await Promise.all(
    WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.map((relativePath) =>
      inspectArtifactPath(resolve(payloadRoot, relativePath), {
        root: payloadRoot,
        label: `packaged candidate ${relativePath}`,
        platform
      })
    )
  )
  return payloadRoot
}

export function windowsCandidateBoundEnvironment({ executableSha256, packagePayload } = {}) {
  if (!lowercaseSha256(executableSha256)) {
    throw new Error('Installed Videorc.exe did not produce a valid lowercase SHA-256 digest.')
  }
  const verifiedPayload = assertWindowsCandidatePayloadIdentity(packagePayload)
  const executableComponent = verifiedPayload.components.find(
    (component) => component.relativePath === 'Videorc.exe'
  )
  if (executableComponent?.sha256 !== executableSha256) {
    throw new Error(
      'Installed Videorc.exe SHA-256 did not match the executable in the packaged-app payload.'
    )
  }
  return {
    VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256: executableSha256,
    VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256: verifiedPayload.sha256
  }
}

export function assertWindowsCandidateBindingUnchanged(expected, actual) {
  const expectedEnvironment = windowsCandidateBoundEnvironment(expected)
  const actualEnvironment = windowsCandidateBoundEnvironment(actual)
  if (
    expectedEnvironment.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256 !==
    actualEnvironment.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256
  ) {
    throw new Error('Installed Videorc.exe changed after candidate identity verification.')
  }
  if (
    expectedEnvironment.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256 !==
    actualEnvironment.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256
  ) {
    throw new Error('Installed packaged-app payload changed after candidate identity verification.')
  }
  return expected
}

export function windowsLocalGateStepCandidateExecutable(step) {
  return (
    step?.env?.VIDEORC_PERF_APP_EXECUTABLE ?? step?.env?.VIDEORC_PACKAGED_APP_EXECUTABLE ?? null
  )
}

export function assertInstalledWindowsCandidateIdentity({
  executablePath,
  releaseId,
  sourceCommit,
  installerSha256,
  expectedAppSha256,
  actualAppSha256,
  expectedPublisher,
  signature,
  productVersion,
  registration
} = {}) {
  const executableName = String(executablePath ?? '')
    .split(/[\\/]/)
    .at(-1)
  if (executableName !== 'Videorc.exe') {
    throw new Error('Installed candidate executable must be named exactly Videorc.exe.')
  }
  const releaseMatch = /^(\d+\.\d+\.\d+)-alpha\.1$/.exec(releaseId ?? '')
  if (!releaseMatch) {
    throw new Error(
      'VIDEORC_RELEASE_ID must be exactly <numeric version>-alpha.1; bump the numeric package version for every candidate.'
    )
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) {
    throw new Error('VIDEORC_RELEASE_SOURCE_COMMIT must be a lowercase full Git commit SHA.')
  }
  if (!/^[a-f0-9]{64}$/.test(installerSha256 ?? '')) {
    throw new Error('VIDEORC_RELEASE_EXPECTED_SHA256 must be a lowercase SHA-256 digest.')
  }
  if (!/^[a-f0-9]{64}$/.test(expectedAppSha256 ?? '')) {
    throw new Error(
      'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256 must be a lowercase SHA-256 digest.'
    )
  }
  if (!/^[a-f0-9]{64}$/.test(actualAppSha256 ?? '')) {
    throw new Error('Installed Videorc.exe did not produce a valid lowercase SHA-256 digest.')
  }
  if (actualAppSha256 !== expectedAppSha256) {
    throw new Error('Installed Videorc.exe SHA-256 does not match the verified private candidate.')
  }
  if (typeof expectedPublisher !== 'string' || !expectedPublisher.trim()) {
    throw new Error('VIDEORC_WINDOWS_PUBLISHER_NAME is required.')
  }
  if (signature?.status !== 'Valid') {
    throw new Error('Installed Videorc.exe Authenticode status must be Valid.')
  }
  if (signature?.publisher !== expectedPublisher.trim()) {
    throw new Error('Installed Videorc.exe publisher does not match the exact pinned publisher.')
  }
  if (signature?.timestampPresent !== true) {
    throw new Error('Installed Videorc.exe must carry an Authenticode timestamp countersignature.')
  }

  const coreVersion = releaseMatch[1]
  if (productVersion !== coreVersion && productVersion !== `${coreVersion}.0`) {
    throw new Error('Installed Videorc.exe ProductVersion does not match the candidate release ID.')
  }
  if (
    registration?.matched !== true ||
    !['HKCU', 'HKLM'].includes(registration?.scope) ||
    registration?.displayName !== 'Videorc' ||
    registration?.uninstallCommandPresent !== true
  ) {
    throw new Error('Installed Videorc.exe must match exactly one registered Videorc NSIS install.')
  }
  if (
    registration.displayVersion !== coreVersion &&
    registration.displayVersion !== `${coreVersion}.0`
  ) {
    throw new Error('Registered NSIS DisplayVersion does not match the candidate release ID.')
  }
  if (
    registration.uninstallerSignature?.status !== 'Valid' ||
    registration.uninstallerSignature?.publisher !== expectedPublisher.trim() ||
    registration.uninstallerSignature?.timestampPresent !== true
  ) {
    throw new Error(
      'Registered NSIS uninstaller must have a valid timestamped signature from the pinned publisher.'
    )
  }

  return {
    verified: true,
    executableName,
    releaseId,
    sourceCommit,
    installerSha256,
    expectedAppSha256,
    actualAppSha256,
    publisherName: expectedPublisher.trim(),
    signatureStatus: signature.status,
    timestampPresent: true,
    productVersion,
    registration: {
      matched: true,
      scope: registration.scope,
      displayName: registration.displayName,
      displayVersion: registration.displayVersion,
      uninstallCommandPresent: true,
      uninstallerSignatureStatus: registration.uninstallerSignature.status,
      uninstallerTimestampPresent: true
    }
  }
}

export function assertWindowsReleaseCandidateArtifactIdentity(
  candidate,
  {
    repoRoot,
    releaseId,
    sourceCommit,
    installerSha256,
    expectedAppSha256,
    expectedPayloadSha256,
    expectedPublisher,
    platform = process.platform
  } = {}
) {
  if (!isAbsolute(repoRoot ?? '')) {
    throw new Error('release candidate artifact verification requires an absolute repository root')
  }
  const releaseDirectory = resolve(repoRoot, 'apps', 'desktop', 'release')
  const manifestPath = resolve(releaseDirectory, 'release.json')
  if (!sameCandidatePath(candidate?.releaseDirectory, releaseDirectory, platform)) {
    throw new Error('release candidate must come from the canonical apps/desktop/release directory')
  }
  if (!sameCandidatePath(candidate?.manifestPath, manifestPath, platform)) {
    throw new Error(
      'release candidate manifest must be canonical apps/desktop/release/release.json'
    )
  }
  if (!lowercaseSha256(candidate?.manifestSha256)) {
    throw new Error('release candidate release.json did not produce a lowercase SHA-256 digest')
  }

  const manifest = assertPendingWindowsCandidateManifest(candidate?.manifest, {
    releaseId,
    sourceCommit,
    installerSha256
  })
  if (manifest.publisherName !== expectedPublisher) {
    throw new Error('release candidate publisherName did not match the exact pinned publisher')
  }
  const installerPath = resolve(releaseDirectory, manifest.filename)
  if (
    !sameCandidatePath(candidate?.installerPath, installerPath, platform) ||
    !sameCandidatePath(dirname(installerPath), releaseDirectory, platform)
  ) {
    throw new Error('release candidate installer escaped the canonical release directory')
  }
  if (
    candidate?.installerSha256 !== installerSha256 ||
    candidate.installerSha256 !== manifest.sha256
  ) {
    throw new Error(
      'release candidate installer bytes did not match release.json and VIDEORC_RELEASE_EXPECTED_SHA256'
    )
  }
  if (candidate?.installerSizeBytes !== manifest.sizeBytes) {
    throw new Error('release candidate installer byte size did not match release.json')
  }
  assertTimestampedWindowsSignature(
    candidate?.installerSignature,
    expectedPublisher,
    'release candidate installer'
  )
  if (
    candidate?.installerPayloadArchiveRelativePath !== '$PLUGINSDIR/app-64.7z' ||
    !lowercaseSha256(candidate?.installerPayloadArchiveSha256)
  ) {
    throw new Error(
      'release candidate installer did not expose exactly one canonical $PLUGINSDIR/app-64.7z payload archive'
    )
  }
  const installerPackagePayload = assertWindowsCandidatePayloadIdentity(
    candidate?.installerPackagePayload
  )
  if (installerPackagePayload.root !== '$PLUGINSDIR/app-64.7z') {
    throw new Error('release candidate installer payload identity had a noncanonical archive root')
  }

  const stagedExecutablePath = resolve(releaseDirectory, 'win-unpacked', 'Videorc.exe')
  if (!sameCandidatePath(candidate?.stagedExecutablePath, stagedExecutablePath, platform)) {
    throw new Error(
      'release candidate packaged executable was not canonical win-unpacked/Videorc.exe'
    )
  }
  if (candidate?.stagedExecutableSha256 !== expectedAppSha256) {
    throw new Error(
      'release candidate packaged Videorc.exe bytes did not match the attested installed app digest'
    )
  }
  assertTimestampedWindowsSignature(
    candidate?.stagedExecutableSignature,
    expectedPublisher,
    'release candidate packaged Videorc.exe'
  )
  const stagedPackagePayload = assertWindowsCandidatePayloadIdentity(
    candidate?.stagedPackagePayload
  )
  if (
    !sameCandidatePath(
      stagedPackagePayload.root,
      resolve(releaseDirectory, 'win-unpacked'),
      platform
    )
  ) {
    throw new Error('release candidate staged payload identity had a noncanonical root')
  }
  if (stagedPackagePayload.sha256 !== expectedPayloadSha256) {
    throw new Error(
      'release candidate packaged payload bytes did not match the attested installed payload digest'
    )
  }
  const stagedExecutableComponent = stagedPackagePayload.components.find(
    (component) => component.relativePath === 'Videorc.exe'
  )
  if (stagedExecutableComponent?.sha256 !== candidate.stagedExecutableSha256) {
    throw new Error(
      'release candidate packaged payload did not bind its exact staged Videorc.exe bytes'
    )
  }
  assertWindowsCandidatePayloadsIdentical(
    installerPackagePayload,
    stagedPackagePayload,
    'NSIS installer and staged candidate'
  )

  return {
    releaseDirectory,
    manifestPath,
    manifestSha256: candidate.manifestSha256,
    manifest,
    installerPath,
    installerSha256: candidate.installerSha256,
    installerSizeBytes: candidate.installerSizeBytes,
    installerSignature: candidate.installerSignature,
    installerPayloadArchiveRelativePath: candidate.installerPayloadArchiveRelativePath,
    installerPayloadArchiveSha256: candidate.installerPayloadArchiveSha256,
    installerPackagePayload,
    stagedExecutablePath,
    stagedExecutableSha256: candidate.stagedExecutableSha256,
    stagedExecutableSignature: candidate.stagedExecutableSignature,
    stagedPackagePayload
  }
}

export async function extractWindowsInstallerPayloadIdentity({
  installerPath,
  repoRoot,
  platform = process.platform,
  arch = process.arch,
  resolveSevenZipPath = resolveBundledSevenZipPath,
  listArchive = listArchiveWithSevenZip,
  extractArchive = extractArchiveWithSevenZip,
  inspectArtifactPath = assertWindowsCandidateArtifactPath,
  inspectPayloadPaths = assertWindowsPackagedPayloadPaths,
  inspectPayload = packagedAppPayloadIdentity,
  hashArchive = sha256File,
  makeTemporaryDirectory = () => mkdtemp(join(tmpdir(), 'videorc-nsis-verify-')),
  removeTemporaryDirectory = (path) => rm(path, { recursive: true, force: true })
} = {}) {
  if (!isAbsolute(installerPath ?? '') || !isAbsolute(repoRoot ?? '')) {
    throw new Error('NSIS payload extraction requires absolute installer and repository paths')
  }
  const requestedScratchRoot = await makeTemporaryDirectory()
  try {
    if (!isAbsolute(requestedScratchRoot ?? '')) {
      throw new Error('NSIS payload extraction temporary directory must be absolute')
    }
    const scratchMetadata = await lstat(requestedScratchRoot)
    if (!scratchMetadata.isDirectory() || scratchMetadata.isSymbolicLink()) {
      throw new Error('NSIS payload extraction temporary directory must be regular and non-symlink')
    }
    const scratchRoot = await realpath(requestedScratchRoot)
    const outerRoot = resolve(scratchRoot, 'installer')
    const payloadRoot = resolve(scratchRoot, 'payload')
    await Promise.all([
      mkdir(outerRoot, { recursive: false }),
      mkdir(payloadRoot, { recursive: false })
    ])
    const sevenZipPath = await resolveSevenZipPath({ repoRoot, platform, arch })
    const installerListing = assertSafeSevenZipArchiveEntries(
      await listArchive({
        sevenZipPath,
        archivePath: resolve(installerPath),
        label: 'signed NSIS installer'
      }),
      {
        label: 'signed NSIS installer',
        requiredCanonicalPath: '$PLUGINSDIR/app-64.7z'
      }
    )
    if (
      installerListing.filter(
        (entry) => entry.normalizedPath.toLocaleLowerCase('en-US') === '$pluginsdir/app-64.7z'
      ).length !== 1
    ) {
      throw new Error(
        'signed NSIS installer must list exactly one normalized $PLUGINSDIR/app-64.7z archive'
      )
    }
    await extractArchive({
      sevenZipPath,
      archivePath: resolve(installerPath),
      outputDirectory: outerRoot,
      label: 'signed NSIS installer'
    })
    const outerEntries = await collectUnaliasedCandidateTree(outerRoot, { platform })
    const appArchives = outerEntries.filter(
      (entry) => entry.type === 'file' && basename(entry.path).toLowerCase() === 'app-64.7z'
    )
    const canonicalArchivePath = resolve(outerRoot, '$PLUGINSDIR', 'app-64.7z')
    if (
      appArchives.length !== 1 ||
      !sameCandidatePath(appArchives[0].path, canonicalArchivePath, platform) ||
      relative(outerRoot, appArchives[0].path).replaceAll('\\', '/') !== '$PLUGINSDIR/app-64.7z'
    ) {
      throw new Error(
        'signed NSIS installer must contain exactly one canonical $PLUGINSDIR/app-64.7z archive'
      )
    }
    await inspectArtifactPath(canonicalArchivePath, {
      root: outerRoot,
      label: 'signed NSIS app-64.7z payload archive',
      platform
    })
    const archiveSha256 = await hashArchive(canonicalArchivePath)
    assertSafeSevenZipArchiveEntries(
      await listArchive({
        sevenZipPath,
        archivePath: canonicalArchivePath,
        label: 'signed NSIS app-64.7z payload archive'
      }),
      { label: 'signed NSIS app-64.7z payload archive' }
    )
    await extractArchive({
      sevenZipPath,
      archivePath: canonicalArchivePath,
      outputDirectory: payloadRoot,
      label: 'signed NSIS app-64.7z payload archive'
    })
    await collectUnaliasedCandidateTree(payloadRoot, { platform })
    const executablePath = resolve(payloadRoot, 'Videorc.exe')
    await inspectPayloadPaths(executablePath, { platform, inspectArtifactPath })
    const packagePayload = assertWindowsCandidatePayloadIdentity(
      await inspectPayload(executablePath, { osPlatform: 'win32' })
    )
    if (!sameCandidatePath(packagePayload.root, payloadRoot, platform)) {
      throw new Error('extracted NSIS payload identity did not retain the exact archive root')
    }
    return {
      archiveRelativePath: '$PLUGINSDIR/app-64.7z',
      archiveSha256,
      packagePayload: {
        ...packagePayload,
        root: '$PLUGINSDIR/app-64.7z'
      }
    }
  } finally {
    await removeTemporaryDirectory(requestedScratchRoot)
  }
}

export async function resolveBundledSevenZipPath({
  repoRoot,
  platform = process.platform,
  arch = process.arch,
  createRequireFrom = createRequire,
  hashExecutable = sha256File
} = {}) {
  if (!isAbsolute(repoRoot ?? '')) {
    throw new Error('bundled 7-Zip resolution requires an absolute repository root')
  }
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`bundled NSIS extraction requires win32/x64, got ${platform}/${arch}`)
  }
  const canonicalRepoRoot = await realpath(resolve(repoRoot))
  const dependencyRoot = resolve(canonicalRepoRoot, 'node_modules')
  const dependencyMetadata = await lstat(dependencyRoot)
  if (!dependencyMetadata.isDirectory() || dependencyMetadata.isSymbolicLink()) {
    throw new Error('repository dependency root must be one regular, non-symlink directory')
  }
  const canonicalDependencyRoot = await realpath(dependencyRoot)
  if (
    !sameCandidatePath(canonicalDependencyRoot, dependencyRoot, platform) ||
    !candidatePathIsInside(canonicalDependencyRoot, canonicalRepoRoot, platform)
  ) {
    throw new Error('repository dependency root escaped through an alias or junction')
  }
  const desktopRequire = createRequireFrom(
    resolve(canonicalRepoRoot, 'apps', 'desktop', 'package.json')
  )
  const electronBuilderPackage = desktopRequire.resolve('electron-builder/package.json')
  await assertContainedRegularFile(
    electronBuilderPackage,
    canonicalDependencyRoot,
    'electron-builder package metadata',
    platform
  )
  const electronBuilderRequire = createRequireFrom(electronBuilderPackage)
  const builderUtilPackage = electronBuilderRequire.resolve('builder-util/package.json')
  await assertContainedRegularFile(
    builderUtilPackage,
    canonicalDependencyRoot,
    'builder-util package metadata',
    platform
  )
  const builderUtilRequire = createRequireFrom(builderUtilPackage)
  const sevenZipPackage = builderUtilRequire.resolve('7zip-bin/package.json')
  await assertContainedRegularFile(
    sevenZipPackage,
    canonicalDependencyRoot,
    '7zip-bin package metadata',
    platform
  )
  let sevenZipMetadata
  try {
    sevenZipMetadata = JSON.parse(await readFile(sevenZipPackage, 'utf8'))
  } catch (error) {
    throw new Error(`7zip-bin package metadata was invalid: ${error.message}`)
  }
  if (
    sevenZipMetadata?.name !== '7zip-bin' ||
    sevenZipMetadata?.version !== WINDOWS_BUNDLED_7ZIP_VERSION
  ) {
    throw new Error(`bundled NSIS extraction requires 7zip-bin ${WINDOWS_BUNDLED_7ZIP_VERSION}`)
  }
  const sevenZipPath = resolve(dirname(sevenZipPackage), 'win', 'x64', '7za.exe')
  const metadata = await assertContainedRegularFile(
    sevenZipPath,
    canonicalDependencyRoot,
    'electron-builder bundled 7za.exe',
    platform
  )
  if (
    metadata.size !== WINDOWS_BUNDLED_7ZIP_X64_SIZE_BYTES ||
    (await hashExecutable(sevenZipPath)) !== WINDOWS_BUNDLED_7ZIP_X64_SHA256
  ) {
    throw new Error('electron-builder bundled 7za.exe bytes did not match the pinned tool')
  }
  return sevenZipPath
}

export function listArchiveWithSevenZip({ sevenZipPath, archivePath, label = 'archive' } = {}) {
  const result = spawnSync(sevenZipPath, ['l', '-slt', '-ba', archivePath], {
    cwd: dirname(archivePath),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `bundled 7-Zip could not list ${label}: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`
    )
  }
  return parseSevenZipTechnicalListing(result.stdout, { label })
}

export function parseSevenZipTechnicalListing(output, { label = 'archive' } = {}) {
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error(`bundled 7-Zip returned an empty ${label} listing`)
  }
  const entries = []
  let current = null
  const finishCurrent = () => {
    if (current?.path !== undefined) entries.push(current)
    current = null
  }
  for (const line of output.split(/\r?\n/)) {
    const property = /^([^=]+?)\s*=\s*(.*)$/.exec(line)
    if (!property) continue
    const key = property[1].trim()
    const value = property[2]
    if (key === 'Path') {
      finishCurrent()
      current = { path: value, size: null, isDirectory: false, unsafeLink: false }
    } else if (current && key === 'Size') {
      current.size = /^\d+$/.test(value) ? Number(value) : Number.NaN
    } else if (current && key === 'Folder') {
      current.isDirectory = value.trim() === '+'
    } else if (
      current &&
      ['Symbolic Link', 'Hard Link', 'Alternate Stream', 'Reparse'].includes(key) &&
      value.trim() &&
      value.trim() !== '-'
    ) {
      current.unsafeLink = true
    }
  }
  finishCurrent()
  return assertSafeSevenZipArchiveEntries(entries, { label })
}

export function assertSafeSevenZipArchiveEntries(
  entries,
  { label = 'archive', requiredCanonicalPath = null } = {}
) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${label} listing did not contain any entries`)
  }
  if (entries.length > WINDOWS_ARCHIVE_MAX_ENTRIES) {
    throw new Error(`${label} listing exceeded the bounded entry-count contract`)
  }
  const seen = new Set()
  let totalBytes = 0
  const normalizedEntries = entries.map((entry) => {
    const normalizedPath = safeWindowsArchiveEntryPath(entry?.path, entry?.isDirectory === true)
    const key = normalizedPath.normalize('NFC').toLocaleLowerCase('en-US')
    if (seen.has(key)) {
      throw new Error(`${label} listing contained duplicate normalized path ${normalizedPath}`)
    }
    seen.add(key)
    if (entry?.unsafeLink === true) {
      throw new Error(`${label} listing contained a link, reparse point, or alternate stream`)
    }
    const size = entry?.isDirectory === true && entry?.size == null ? 0 : entry?.size
    if (!Number.isSafeInteger(size) || size < 0 || size > WINDOWS_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`${label} listing contained an invalid or oversized entry`)
    }
    totalBytes += size
    if (totalBytes > WINDOWS_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`${label} listing exceeded the bounded uncompressed-byte contract`)
    }
    return { ...entry, normalizedPath, size }
  })
  if (requiredCanonicalPath) {
    const requiredKey = requiredCanonicalPath.toLocaleLowerCase('en-US')
    const required = normalizedEntries.filter(
      (entry) => entry.normalizedPath.toLocaleLowerCase('en-US') === requiredKey
    )
    if (
      required.length !== 1 ||
      required[0].normalizedPath !== requiredCanonicalPath ||
      required[0].isDirectory === true
    ) {
      throw new Error(`${label} must list exactly one canonical ${requiredCanonicalPath} file`)
    }
  }
  return normalizedEntries
}

export function extractArchiveWithSevenZip({
  sevenZipPath,
  archivePath,
  outputDirectory,
  label = 'archive'
} = {}) {
  const result = spawnSync(
    sevenZipPath,
    ['x', '-y', '-bb0', '-bd', `-o${outputDirectory}`, archivePath],
    {
      cwd: dirname(outputDirectory),
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024
    }
  )
  if (result.error || result.status !== 0) {
    throw new Error(
      `bundled 7-Zip could not extract ${label}: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`
    )
  }
}

export async function inspectCanonicalWindowsReleaseCandidate({
  repoRoot,
  releaseId,
  sourceCommit,
  installerSha256,
  expectedAppSha256,
  expectedPayloadSha256,
  expectedPublisher,
  platform = process.platform,
  readManifest = readFile,
  inspectArtifactPath = assertWindowsCandidateArtifactPath,
  hashInstaller = sha256File,
  inspectInstallerSignature = readWindowsAuthenticodeSignature,
  hashStagedExecutable = sha256File,
  inspectStagedExecutableSignature = readWindowsAuthenticodeSignature,
  inspectStagedPayload = packagedAppPayloadIdentity,
  extractInstallerPayload = extractWindowsInstallerPayloadIdentity,
  readArtifactMetadata = stat
} = {}) {
  if (!isAbsolute(repoRoot ?? '')) {
    throw new Error('release candidate artifact verification requires an absolute repository root')
  }
  const releaseDirectory = resolve(repoRoot, 'apps', 'desktop', 'release')
  const manifestPath = resolve(releaseDirectory, 'release.json')
  await inspectArtifactPath(manifestPath, {
    root: releaseDirectory,
    label: 'release candidate release.json',
    platform
  })
  const manifestBytesValue = await readManifest(manifestPath)
  const manifestBytes = Buffer.isBuffer(manifestBytesValue)
    ? manifestBytesValue
    : Buffer.from(String(manifestBytesValue), 'utf8')
  if (manifestBytes.length === 0 || manifestBytes.length > 64 * 1024) {
    throw new Error('release candidate release.json must be between 1 byte and 64 KiB')
  }
  let manifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch (error) {
    throw new Error(`release candidate release.json was invalid JSON: ${error.message}`)
  }
  assertPendingWindowsCandidateManifest(manifest, {
    releaseId,
    sourceCommit,
    installerSha256
  })

  const installerPath = resolve(releaseDirectory, manifest.filename)
  const stagedExecutablePath = resolve(releaseDirectory, 'win-unpacked', 'Videorc.exe')
  const stagedPayloadPaths = WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.map((relativePath) =>
    resolve(releaseDirectory, 'win-unpacked', relativePath)
  )
  await Promise.all([
    inspectArtifactPath(installerPath, {
      root: releaseDirectory,
      label: 'release candidate installer',
      platform
    }),
    ...stagedPayloadPaths.map((path, index) =>
      inspectArtifactPath(path, {
        root: releaseDirectory,
        label: `release candidate packaged ${WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS[index]}`,
        platform
      })
    )
  ])
  const [
    installerMetadataBefore,
    actualInstallerSha256,
    installerSignatureBefore,
    stagedExecutableSha256,
    stagedExecutableSignature,
    stagedPackagePayload
  ] = await Promise.all([
    readArtifactMetadata(installerPath),
    hashInstaller(installerPath),
    inspectInstallerSignature(installerPath),
    hashStagedExecutable(stagedExecutablePath),
    inspectStagedExecutableSignature(stagedExecutablePath),
    inspectStagedPayload(stagedExecutablePath, { osPlatform: 'win32' })
  ])
  if (
    installerMetadataBefore?.size !== manifest.sizeBytes ||
    actualInstallerSha256 !== installerSha256 ||
    actualInstallerSha256 !== manifest.sha256
  ) {
    throw new Error(
      'release candidate installer bytes did not match release.json and VIDEORC_RELEASE_EXPECTED_SHA256'
    )
  }
  assertTimestampedWindowsSignature(
    installerSignatureBefore,
    expectedPublisher,
    'release candidate installer before payload extraction'
  )
  const installerPayload = await extractInstallerPayload({
    installerPath,
    repoRoot,
    platform,
    arch: 'x64'
  })
  const [installerMetadataAfter, installerSha256After, installerSignature] = await Promise.all([
    readArtifactMetadata(installerPath),
    hashInstaller(installerPath),
    inspectInstallerSignature(installerPath)
  ])
  if (
    installerMetadataBefore?.size !== installerMetadataAfter?.size ||
    actualInstallerSha256 !== installerSha256After ||
    JSON.stringify(installerSignatureBefore) !== JSON.stringify(installerSignature)
  ) {
    throw new Error('release candidate installer changed while its embedded payload was extracted')
  }
  return assertWindowsReleaseCandidateArtifactIdentity(
    {
      releaseDirectory,
      manifestPath,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      manifest,
      installerPath,
      installerSha256: actualInstallerSha256,
      installerSizeBytes: installerMetadataAfter?.size,
      installerSignature,
      installerPayloadArchiveRelativePath: installerPayload?.archiveRelativePath,
      installerPayloadArchiveSha256: installerPayload?.archiveSha256,
      installerPackagePayload: installerPayload?.packagePayload,
      stagedExecutablePath,
      stagedExecutableSha256,
      stagedExecutableSignature,
      stagedPackagePayload
    },
    {
      repoRoot,
      releaseId,
      sourceCommit,
      installerSha256,
      expectedAppSha256,
      expectedPayloadSha256,
      expectedPublisher,
      platform
    }
  )
}

export async function verifyInstalledWindowsCandidate({
  executablePath,
  repoRoot,
  env = process.env,
  platform = process.platform,
  inspectFacts = readInstalledWindowsCandidateFacts,
  hashExecutable = sha256File,
  inspectPayload = packagedAppPayloadIdentity,
  inspectPayloadPaths = assertWindowsPackagedPayloadPaths,
  inspectGit = readWindowsCandidateGitState,
  inspectExecutablePath = assertWindowsInstalledExecutablePath,
  inspectReleaseCandidate = inspectCanonicalWindowsReleaseCandidate
} = {}) {
  if (platform !== 'win32') {
    throw new Error('installed candidate identity can only be verified on Windows')
  }
  if (env.VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED !== '1') {
    throw new Error(
      'installed candidate verification requires VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED=1'
    )
  }
  if (!isAbsolute(executablePath ?? '')) {
    throw new Error('installed candidate executable path must be absolute')
  }
  if (!isAbsolute(repoRoot ?? '')) {
    throw new Error('installed candidate verification requires an absolute repository root')
  }
  const resolvedExecutable = resolve(executablePath)
  const resolvedRepoRoot = resolve(repoRoot)
  await inspectExecutablePath(resolvedExecutable)
  const installedPayloadRoot = await inspectPayloadPaths(resolvedExecutable, { platform })
  const stagingRoot = resolve(resolvedRepoRoot, 'apps', 'desktop', 'release')
  const stagingRelative = relative(stagingRoot, resolvedExecutable)
  if (!stagingRelative.startsWith('..') && !isAbsolute(stagingRelative)) {
    throw new Error('release staging files cannot substitute for an NSIS-installed candidate')
  }

  const releaseId = requiredCandidateEnvironment(env, 'VIDEORC_RELEASE_ID')
  const sourceCommit = requiredCandidateEnvironment(env, 'VIDEORC_RELEASE_SOURCE_COMMIT')
  const installerSha256 = requiredCandidateEnvironment(env, 'VIDEORC_RELEASE_EXPECTED_SHA256')
  const expectedAppSha256 = requiredCandidateEnvironment(
    env,
    'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256'
  )
  const expectedPayloadSha256 = requiredCandidateEnvironment(
    env,
    'VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256'
  )
  const expectedPublisher = requiredCandidateEnvironment(env, 'VIDEORC_WINDOWS_PUBLISHER_NAME')
  const git = await inspectGit({ repoRoot: resolvedRepoRoot })
  if (
    String(git?.head ?? '')
      .trim()
      .toLocaleLowerCase('en-US') !== sourceCommit
  ) {
    throw new Error('installed candidate source commit did not match the checkout HEAD')
  }
  const changedPaths = windowsCandidateChangedPaths(git)
  const disallowedChanges = changedPaths.filter(
    (path) => !WINDOWS_POST_BUILD_ALLOWED_GIT_PATHS.includes(path)
  )
  if (disallowedChanges.length > 0) {
    throw new Error(
      `installed candidate checkout contains post-build changes outside the Plan 040 documentation allowlist: ${disallowedChanges.join(', ')}`
    )
  }

  const [facts, actualAppSha256, packagePayload, inspectedReleaseCandidate] = await Promise.all([
    inspectFacts(resolvedExecutable),
    hashExecutable(resolvedExecutable),
    inspectPayload(resolvedExecutable, { osPlatform: 'win32' }),
    inspectReleaseCandidate({
      repoRoot: resolvedRepoRoot,
      releaseId,
      sourceCommit,
      installerSha256,
      expectedAppSha256,
      expectedPayloadSha256,
      expectedPublisher,
      platform
    })
  ])
  const releaseCandidate = assertWindowsReleaseCandidateArtifactIdentity(
    inspectedReleaseCandidate,
    {
      repoRoot: resolvedRepoRoot,
      releaseId,
      sourceCommit,
      installerSha256,
      expectedAppSha256,
      expectedPayloadSha256,
      expectedPublisher,
      platform
    }
  )
  const verifiedIdentity = assertInstalledWindowsCandidateIdentity({
    executablePath: resolvedExecutable,
    releaseId,
    sourceCommit,
    installerSha256: releaseCandidate.installerSha256,
    expectedAppSha256,
    actualAppSha256,
    expectedPublisher,
    signature: facts?.signature,
    productVersion: facts?.productVersion,
    registration: facts?.registration
  })
  const verifiedPayload = assertWindowsCandidatePayloadIdentity(packagePayload)
  if (!sameCandidatePath(verifiedPayload.root, installedPayloadRoot, platform)) {
    throw new Error('installed packaged-app payload identity had a noncanonical root')
  }
  assertWindowsCandidatePayloadsIdentical(
    releaseCandidate.installerPackagePayload,
    verifiedPayload,
    'NSIS installer and installed candidate'
  )
  const boundEnvironment = windowsCandidateBoundEnvironment({
    executableSha256: actualAppSha256,
    packagePayload: verifiedPayload
  })
  if (
    boundEnvironment.VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_PAYLOAD_SHA256 !== expectedPayloadSha256
  ) {
    throw new Error('installed packaged-app payload digest did not match the attested candidate')
  }
  return {
    ...verifiedIdentity,
    executablePath: resolvedExecutable,
    executableSha256: actualAppSha256,
    packagePayload: verifiedPayload,
    releaseCandidate,
    signature: facts.signature,
    productVersion: facts.productVersion,
    git: {
      head: sourceCommit,
      clean: changedPaths.length === 0,
      allowedPostBuildChanges: changedPaths
    },
    boundEnvironment
  }
}

export function assertWindowsCandidateVerificationUnchanged(expected, actual) {
  const identityFields = [
    'releaseId',
    'sourceCommit',
    'installerSha256',
    'publisherName',
    'executablePath',
    'executableSha256',
    'productVersion'
  ]
  for (const field of identityFields) {
    if (expected?.[field] !== actual?.[field]) {
      throw new Error(`installed Windows candidate ${field} changed during protected evidence`)
    }
  }
  for (const field of [
    'releaseDirectory',
    'manifestPath',
    'manifestSha256',
    'installerPath',
    'installerSha256',
    'installerSizeBytes',
    'installerPayloadArchiveRelativePath',
    'installerPayloadArchiveSha256',
    'stagedExecutablePath',
    'stagedExecutableSha256'
  ]) {
    if (expected?.releaseCandidate?.[field] !== actual?.releaseCandidate?.[field]) {
      throw new Error(
        `canonical Windows release candidate ${field} changed during protected evidence`
      )
    }
  }
  assertWindowsCandidateBindingUnchanged(
    {
      executableSha256: expected?.executableSha256,
      packagePayload: expected?.packagePayload
    },
    {
      executableSha256: actual?.executableSha256,
      packagePayload: actual?.packagePayload
    }
  )
  if (
    expected?.releaseCandidate?.stagedPackagePayload?.sha256 !==
    actual?.releaseCandidate?.stagedPackagePayload?.sha256
  ) {
    throw new Error('canonical Windows release candidate payload changed during protected evidence')
  }
  assertWindowsCandidatePayloadsIdentical(
    expected?.releaseCandidate?.installerPackagePayload,
    actual?.releaseCandidate?.installerPackagePayload,
    'canonical NSIS installer'
  )
  return expected
}

export async function revalidateInstalledWindowsCandidate({
  expectedCandidate,
  verifyCandidate = verifyInstalledWindowsCandidate,
  ...verification
} = {}) {
  if (expectedCandidate?.verified !== true) {
    throw new Error('final candidate revalidation requires an initially verified candidate')
  }
  const actual = await verifyCandidate({
    ...verification,
    executablePath: expectedCandidate.executablePath
  })
  assertWindowsCandidateVerificationUnchanged(expectedCandidate, actual)
  return actual
}

export async function assertWindowsInstalledExecutablePath(executablePath) {
  const metadata = await lstat(executablePath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('installed candidate executable must be one regular, non-symlink file')
  }
  const actual = await realpath(executablePath)
  if (actual.toLocaleLowerCase('en-US') !== resolve(executablePath).toLocaleLowerCase('en-US')) {
    throw new Error('installed candidate executable path must not traverse an alias or junction')
  }
  return actual
}

export async function assertWindowsCandidateArtifactPath(
  artifactPath,
  { root, label = 'release candidate artifact', platform = process.platform } = {}
) {
  if (!isAbsolute(artifactPath ?? '') || !isAbsolute(root ?? '')) {
    throw new Error(`${label} path and canonical root must be absolute`)
  }
  const requested = resolve(artifactPath)
  const canonicalRoot = resolve(root)
  const rootRelative = relative(canonicalRoot, requested)
  if (
    rootRelative === '' ||
    rootRelative === '..' ||
    rootRelative.startsWith(`..${sep}`) ||
    isAbsolute(rootRelative)
  ) {
    throw new Error(`${label} escaped the canonical release directory`)
  }
  const metadata = await lstat(requested)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be one regular, non-symlink file`)
  }
  const actual = await realpath(requested)
  if (!sameCandidatePath(actual, requested, platform)) {
    throw new Error(`${label} path must not traverse an alias or junction`)
  }
  return actual
}

export function readWindowsAuthenticodeSignature(targetPath) {
  const script = [
    '$sig = Get-AuthenticodeSignature -LiteralPath $env:VIDEORC_SIGNATURE_TARGET',
    '$publisher = if ($sig.SignerCertificate) { $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { $null }',
    '[pscustomobject]@{ status = [string]$sig.Status; publisher = $publisher; timestampPresent = ($null -ne $sig.TimeStamperCertificate) } | ConvertTo-Json -Compress'
  ].join('; ')
  const result = spawnSync(
    process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: { ...process.env, VIDEORC_SIGNATURE_TARGET: targetPath },
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 1024 * 1024
    }
  )
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(
      `PowerShell could not verify Authenticode for ${targetPath}: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`
    )
  }
  try {
    return JSON.parse(result.stdout.trim())
  } catch (error) {
    throw new Error(`PowerShell returned invalid Authenticode facts: ${error.message}`)
  }
}

export function readInstalledWindowsCandidateFacts(executablePath) {
  const script = windowsInstalledCandidateFactsPowerShellScript()
  const result = spawnSync(
    process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: { ...process.env, VIDEORC_SIGNATURE_TARGET: executablePath },
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 1024 * 1024
    }
  )
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(
      `PowerShell could not read installed executable identity and NSIS registration facts: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`
    )
  }
  try {
    return JSON.parse(result.stdout.trim())
  } catch (error) {
    throw new Error(`PowerShell returned invalid installed candidate facts: ${error.message}`)
  }
}

export function windowsInstalledCandidateFactsPowerShellScript() {
  return [
    '$target = (Resolve-Path -LiteralPath $env:VIDEORC_SIGNATURE_TARGET).Path',
    '$item = Get-Item -LiteralPath $target',
    '$sig = Get-AuthenticodeSignature -LiteralPath $target',
    '$publisher = if ($sig.SignerCertificate) { $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { $null }',
    '$registrations = @()',
    '$roots = @(@{ path = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"; scope = "HKCU" }, @{ path = "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"; scope = "HKLM" }, @{ path = "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"; scope = "HKLM" })',
    'foreach ($root in $roots) { if (-not (Test-Path $root.path)) { continue }; foreach ($key in Get-ChildItem -LiteralPath $root.path) { $entry = Get-ItemProperty -LiteralPath $key.PSPath; if ([string]$entry.DisplayName -ne "Videorc") { continue }; $command = [string]$entry.UninstallString; if ($command -notmatch "^\\s*`\"([^`\"]+\\.exe)`\"") { continue }; $uninstaller = [Environment]::ExpandEnvironmentVariables($Matches[1]); if (-not (Test-Path -LiteralPath $uninstaller)) { continue }; $registeredApp = Join-Path (Split-Path -Parent $uninstaller) "Videorc.exe"; if (-not (Test-Path -LiteralPath $registeredApp)) { continue }; if ((Resolve-Path -LiteralPath $registeredApp).Path -ine $target) { continue }; $uninstallerSig = Get-AuthenticodeSignature -LiteralPath $uninstaller; $uninstallerPublisher = if ($uninstallerSig.SignerCertificate) { $uninstallerSig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { $null }; $registrations += [pscustomobject]@{ matched = $true; scope = $root.scope; displayName = [string]$entry.DisplayName; displayVersion = [string]$entry.DisplayVersion; uninstallCommandPresent = $true; uninstallerSignature = [pscustomobject]@{ status = [string]$uninstallerSig.Status; publisher = $uninstallerPublisher; timestampPresent = ($null -ne $uninstallerSig.TimeStamperCertificate) } } } }',
    'if ($registrations.Count -ne 1) { throw "Expected exactly one registered Videorc NSIS install matching the target executable." }',
    '[pscustomobject]@{ productVersion = [string]$item.VersionInfo.ProductVersion; signature = [pscustomobject]@{ status = [string]$sig.Status; publisher = $publisher; timestampPresent = ($null -ne $sig.TimeStamperCertificate) }; registration = $registrations[0] } | ConvertTo-Json -Compress -Depth 5'
  ].join('; ')
}

export function readWindowsCandidateGitState({ repoRoot } = {}) {
  const run = (args) => {
    const result = spawnSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 15_000
    })
    if (result.error || result.status !== 0) {
      throw new Error(
        `Git candidate-source verification failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`
      )
    }
    return result.stdout
  }
  return {
    head: run(['rev-parse', 'HEAD']).trim(),
    changedPaths: [
      ...run(['diff', '--name-only', '--no-renames', 'HEAD', '--']).split(/\r?\n/),
      ...run(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/)
    ]
      .map(normalizeRepositoryPath)
      .filter(Boolean)
  }
}

export function windowsCandidateChangedPaths(git = {}) {
  if (Array.isArray(git.changedPaths)) {
    return [...new Set(git.changedPaths.map(normalizeRepositoryPath).filter(Boolean))].sort()
  }
  return [
    ...new Set(
      String(git.status ?? '')
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          const statusPath = line.length >= 3 ? line.slice(3).trim() : line.trim()
          return statusPath
            .split(/\s+->\s+/)
            .map(normalizeRepositoryPath)
            .filter(Boolean)
        })
    )
  ].sort()
}

function assertTimestampedWindowsSignature(signature, expectedPublisher, label) {
  if (signature?.status !== 'Valid') {
    throw new Error(`${label} Authenticode status must be Valid`)
  }
  if (signature?.publisher !== expectedPublisher) {
    throw new Error(`${label} publisher did not match the exact pinned publisher`)
  }
  if (signature?.timestampPresent !== true) {
    throw new Error(`${label} must carry an Authenticode timestamp countersignature`)
  }
  return signature
}

async function collectUnaliasedCandidateTree(root, { platform = process.platform } = {}) {
  const canonicalRoot = resolve(root)
  const rootMetadata = await lstat(canonicalRoot)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('extracted candidate root must be one regular, non-aliased directory')
  }
  const actualRoot = await realpath(canonicalRoot)
  if (!sameCandidatePath(actualRoot, canonicalRoot, platform)) {
    throw new Error('extracted candidate root must not traverse an alias or junction')
  }
  const entries = []
  let totalBytes = 0
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        throw new Error(`extracted candidate entry must not be a symlink or junction: ${path}`)
      }
      const actual = await realpath(path)
      const rootRelative = relative(canonicalRoot, actual)
      if (
        rootRelative === '' ||
        rootRelative === '..' ||
        rootRelative.startsWith(`..${sep}`) ||
        isAbsolute(rootRelative) ||
        !sameCandidatePath(actual, path, platform)
      ) {
        throw new Error(`extracted candidate entry escaped through an alias or junction: ${path}`)
      }
      if (metadata.isDirectory()) {
        entries.push({ path, type: 'directory', size: 0 })
        await visit(path)
      } else if (metadata.isFile()) {
        totalBytes += metadata.size
        entries.push({ path, type: 'file', size: metadata.size })
      } else {
        throw new Error(`extracted candidate entry was not a regular file or directory: ${path}`)
      }
      if (entries.length > 20_000 || totalBytes > 4 * 1024 * 1024 * 1024) {
        throw new Error('extracted candidate exceeded the bounded file-count or byte-size contract')
      }
    }
  }
  await visit(canonicalRoot)
  return entries
}

async function assertContainedRegularFile(path, root, label, platform) {
  const requested = resolve(path)
  if (!candidatePathIsInside(requested, root, platform)) {
    throw new Error(`${label} resolved outside this repository's dependency tree`)
  }
  const metadata = await lstat(requested)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be one regular, non-symlink file`)
  }
  const actual = await realpath(requested)
  if (
    !sameCandidatePath(actual, requested, platform) ||
    !candidatePathIsInside(actual, root, platform)
  ) {
    throw new Error(`${label} escaped through an alias or junction`)
  }
  return metadata
}

function candidatePathIsInside(path, root, platform = process.platform) {
  const normalizedPath =
    platform === 'win32' ? resolve(path).toLocaleLowerCase('en-US') : resolve(path)
  const normalizedRoot =
    platform === 'win32' ? resolve(root).toLocaleLowerCase('en-US') : resolve(root)
  const rootRelative = relative(normalizedRoot, normalizedPath)
  return (
    rootRelative !== '' &&
    rootRelative !== '..' &&
    !rootRelative.startsWith(`..${sep}`) &&
    !isAbsolute(rootRelative)
  )
}

function safeWindowsArchiveEntryPath(value, isDirectory) {
  if (typeof value !== 'string' || !value || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error('archive listing contained an empty or control-character path')
  }
  const slashPath = value.replaceAll('\\', '/')
  if (/^(?:[a-z]:|\/)/i.test(slashPath)) {
    throw new Error(`archive listing contained an absolute path: ${value}`)
  }
  const normalizedPath = isDirectory ? slashPath.replace(/\/$/, '') : slashPath
  const segments = normalizedPath.split('/')
  if (
    !normalizedPath ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[<>:"|?*]/.test(segment) ||
        /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) ||
        /[. ]$/.test(segment)
    )
  ) {
    throw new Error(`archive listing contained an unsafe normalized path: ${value}`)
  }
  return normalizedPath
}

function sameCandidatePath(left, right, platform = process.platform) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight
}

function normalizeRepositoryPath(value) {
  return typeof value === 'string'
    ? value.trim().replace(/^"|"$/g, '').replaceAll('\\', '/').replace(/^\.\//, '')
    : ''
}

function requiredCandidateEnvironment(env, name) {
  const value = env?.[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required for installed candidate verification`)
  }
  return value.trim()
}

export function buildWindowsLocalGateSteps({
  repoRoot,
  packagedAppExecutable,
  useExistingCandidate = false,
  acceptanceDir
} = {}) {
  if (!repoRoot) {
    throw new Error('repoRoot is required.')
  }
  const executable =
    packagedAppExecutable ?? resolve(repoRoot, 'apps/desktop/release/win-unpacked/Videorc.exe')
  const packagedResources = packagedAppExecutable
    ? join(dirname(executable), 'resources')
    : resolve(repoRoot, 'apps/desktop/release/win-unpacked/resources')
  const packagedFfmpeg = join(packagedResources, 'ffmpeg', 'bin', 'ffmpeg.exe')
  const packagedFfprobe = join(packagedResources, 'ffmpeg', 'bin', 'ffprobe.exe')
  const outputDir = acceptanceDir
    ? resolve(repoRoot, acceptanceDir)
    : defaultWindowsAcceptanceArtifactDir({ repoRoot })
  const supportBundlePath = join(outputDir, 'support-bundle.json')
  const [supportBundleVerifierCommand, ...supportBundleVerifierArgs] =
    windowsSupportBundleVerifierCommand({ bundlePath: supportBundlePath })

  const sourceAndProcessSteps = [
    {
      label: 'desktop unit tests',
      command: 'pnpm',
      args: ['--filter', '@videorc/desktop', 'test']
    },
    {
      label: 'exact Windows D3D11 Rust test discovery and focused tests',
      command: 'pnpm',
      args: ['smoke:windows-d3d11-media', '--', '--verify-windows-rust']
    },
    {
      label: 'complete Windows backend test suite',
      command: 'cargo',
      args: ['test', '-p', 'videorc-backend', '--no-fail-fast']
    },
    {
      label: 'complete Windows backend clippy',
      command: 'cargo',
      args: ['clippy', '-p', 'videorc-backend', '--all-targets', '--', '-D', 'warnings']
    },
    {
      label: 'backend capture-input seam tests',
      command: 'cargo',
      args: ['test', '-p', 'videorc-backend', 'capture_input']
    },
    {
      label: 'backend FIFO seam tests',
      command: 'cargo',
      args: ['test', '-p', 'videorc-backend', 'fifo']
    },
    {
      label: 'owned process lifecycle cleanup smoke',
      command: 'pnpm',
      args: ['smoke:process-lifecycle'],
      env: {
        VIDEORC_SMOKE_OUTPUT_DIR: join(outputDir, 'process-lifecycle')
      }
    }
  ]
  const localPackageSteps = useExistingCandidate
    ? []
    : [
        {
          label: 'build release backend',
          command: 'pnpm',
          args: ['package:backend']
        },
        {
          label: 'fetch pinned Windows FFmpeg',
          command: 'pnpm',
          args: ['ffmpeg:fetch:windows']
        },
        {
          label: 'Windows package preflight',
          command: 'pnpm',
          args: ['package:preflight:windows']
        },
        {
          label: 'package desktop Windows dir',
          command: 'pnpm',
          args: ['--filter', '@videorc/desktop', 'package']
        }
      ]

  return [
    ...sourceAndProcessSteps,
    ...localPackageSteps,
    {
      label: 'packaged recording and bundled-background smoke',
      command: 'pnpm',
      args: ['smoke:packaged:bundled'],
      env: {
        VIDEORC_PACKAGED_APP_EXECUTABLE: executable,
        VIDEORC_SMOKE_OUTPUT_DIR: outputDir
      }
    },
    {
      label: 'native Windows ScreenOnly D3D11 zero-copy smoke',
      command: 'pnpm',
      args: ['smoke:windows-native-screen', '--', '--d3d11', '--require-d3d11'],
      env: {
        VIDEORC_PERF_APP_EXECUTABLE: executable,
        VIDEORC_SMOKE_OUTPUT_DIR: join(outputDir, 'native-screen'),
        VIDEORC_SMOKE_FFMPEG_PATH: packagedFfmpeg,
        VIDEORC_SMOKE_FFPROBE_PATH: packagedFfprobe,
        VIDEORC_SMOKE_TIMEOUT_MS: '180000',
        VIDEORC_WINDOWS_NATIVE_SCREEN_RECORDING_MS: '6000'
      }
    },
    {
      label: 'native Windows ScreenCamera D3D11 direct-record smoke 1080p30',
      command: 'pnpm',
      args: ['smoke:windows-native-screen', '--', '--d3d11', '--require-d3d11'],
      env: {
        VIDEORC_PERF_APP_EXECUTABLE: executable,
        VIDEORC_SMOKE_OUTPUT_DIR: join(outputDir, 'native-screen-camera-1080p30'),
        VIDEORC_SMOKE_FFMPEG_PATH: packagedFfmpeg,
        VIDEORC_SMOKE_FFPROBE_PATH: packagedFfprobe,
        VIDEORC_SMOKE_TIMEOUT_MS: '240000',
        VIDEORC_WINDOWS_NATIVE_SCREEN_RECORDING_MS: '8000',
        VIDEORC_WINDOWS_INCLUDE_CAMERA: '1',
        VIDEORC_WINDOWS_REQUIRE_DIRECT_D3D11_RECORDING: '1',
        VIDEORC_SMOKE_VIDEO_WIDTH: '1920',
        VIDEORC_SMOKE_VIDEO_HEIGHT: '1080',
        VIDEORC_SMOKE_VIDEO_FPS: '30',
        VIDEORC_SMOKE_VIDEO_BITRATE_KBPS: '6000'
      }
    },
    {
      label: 'native Windows ScreenCamera D3D11 direct-record smoke 1080p60',
      command: 'pnpm',
      args: ['smoke:windows-native-screen', '--', '--d3d11', '--require-d3d11'],
      env: {
        VIDEORC_PERF_APP_EXECUTABLE: executable,
        VIDEORC_SMOKE_OUTPUT_DIR: join(outputDir, 'native-screen-camera-1080p60'),
        VIDEORC_SMOKE_FFMPEG_PATH: packagedFfmpeg,
        VIDEORC_SMOKE_FFPROBE_PATH: packagedFfprobe,
        VIDEORC_SMOKE_TIMEOUT_MS: '240000',
        VIDEORC_WINDOWS_NATIVE_SCREEN_RECORDING_MS: '8000',
        VIDEORC_WINDOWS_INCLUDE_CAMERA: '1',
        VIDEORC_WINDOWS_REQUIRE_DIRECT_D3D11_RECORDING: '1',
        VIDEORC_SMOKE_VIDEO_WIDTH: '1920',
        VIDEORC_SMOKE_VIDEO_HEIGHT: '1080',
        VIDEORC_SMOKE_VIDEO_FPS: '60',
        VIDEORC_SMOKE_VIDEO_BITRATE_KBPS: '6000'
      }
    },
    {
      label: 'native Windows D3D11 Media Foundation encoded-bridge matrix',
      command: 'pnpm',
      args: [
        'smoke:windows-encoded-bridge',
        '--',
        '--profiles',
        '1080p30,1080p60',
        '--d3d11',
        '--require-d3d11'
      ],
      env: {
        VIDEORC_PERF_APP_EXECUTABLE: executable,
        VIDEORC_SMOKE_OUTPUT_DIR: join(outputDir, 'encoded-bridge'),
        VIDEORC_SMOKE_FFMPEG_PATH: packagedFfmpeg,
        VIDEORC_SMOKE_FFPROBE_PATH: packagedFfprobe,
        VIDEORC_SMOKE_TIMEOUT_MS: '240000',
        VIDEORC_WINDOWS_ENCODED_BRIDGE_RECORDING_MS: '8000'
      }
    },
    {
      label: 'recording-time Windows D3D11 native-preview smoke',
      command: 'pnpm',
      args: ['smoke:recording-native-preview', '--', '--d3d11', '--require-d3d11'],
      env: {
        VIDEORC_PERF_APP_EXECUTABLE: executable,
        VIDEORC_SMOKE_OUTPUT_DIR: join(outputDir, 'd3d11-preview'),
        VIDEORC_SMOKE_FFMPEG_PATH: packagedFfmpeg,
        VIDEORC_SMOKE_FFPROBE_PATH: packagedFfprobe,
        VIDEORC_SMOKE_TIMEOUT_MS: '180000',
        VIDEORC_NATIVE_PREVIEW_RECORDING_MS: '8000',
        VIDEORC_NATIVE_PREVIEW_WARMUP_MS: '2000',
        VIDEORC_NATIVE_PREVIEW_MEASUREMENT_MS: '4000',
        VIDEORC_EXPECT_NATIVE_METAL_PREVIEW: '0',
        VIDEORC_NATIVE_PREVIEW_EXERCISE_PROOF_POLLING: '0',
        VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'windows-media-foundation-h264-mpegts'
      }
    },
    {
      label: 'protected physical Windows RTMP matrix (forced D3D11/MF)',
      command: 'pnpm',
      args: [
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
      ],
      blockedExitCode: 2,
      blockedReportPath: join(outputDir, 'stream-performance-forced', 'aggregate.json'),
      env: {
        VIDEORC_PERF_APP_EXECUTABLE: executable,
        VIDEORC_SMOKE_OUTPUT_DIR: join(outputDir, 'stream-performance-forced'),
        VIDEORC_SMOKE_FFMPEG_PATH: packagedFfmpeg,
        VIDEORC_SMOKE_FFPROBE_PATH: packagedFfprobe,
        VIDEORC_SMOKE_TIMEOUT_MS: '420000'
      }
    },
    {
      label: 'protected physical Windows RTMP matrix (automatic default)',
      command: 'pnpm',
      args: [
        'smoke:windows-stream-performance',
        '--',
        '--gate',
        '--profiles',
        '1080p30,1080p60',
        '--path-evidence',
        'default'
      ],
      blockedExitCode: 2,
      blockedReportPath: join(outputDir, 'stream-performance-default', 'aggregate.json'),
      env: {
        VIDEORC_PERF_APP_EXECUTABLE: executable,
        VIDEORC_SMOKE_OUTPUT_DIR: join(outputDir, 'stream-performance-default'),
        VIDEORC_SMOKE_FFMPEG_PATH: packagedFfmpeg,
        VIDEORC_SMOKE_FFPROBE_PATH: packagedFfprobe,
        VIDEORC_SMOKE_TIMEOUT_MS: '420000'
      }
    },
    {
      label: 'physical Windows live microphone controls smoke',
      command: 'pnpm',
      args: ['smoke:windows-live-audio-controls'],
      blockedExitCode: 2,
      blockedReportPath: join(outputDir, 'live-audio-controls', 'windows-live-audio-controls.json'),
      env: {
        VIDEORC_PERF_APP_EXECUTABLE: executable,
        VIDEORC_SMOKE_OUTPUT_DIR: join(outputDir, 'live-audio-controls'),
        VIDEORC_SMOKE_FFMPEG_PATH: packagedFfmpeg,
        VIDEORC_SMOKE_FFPROBE_PATH: packagedFfprobe,
        VIDEORC_SMOKE_TIMEOUT_MS: '240000',
        VIDEORC_WINDOWS_SUPPORT_BUNDLE_PATH: supportBundlePath
      }
    },
    {
      label: 'strict Windows support-bundle verification',
      command: supportBundleVerifierCommand,
      args: supportBundleVerifierArgs
    }
  ]
}

export function classifyWindowsLocalGateStepExit(step, code) {
  if (code === 0) return 'passed'
  if (step?.blockedExitCode && code === step.blockedExitCode) return 'blocked'
  return 'failed'
}

export function formatWindowsLocalGatePlan({ host, steps }) {
  const lines = ['windows-local-gates: plan']
  const outputDir = windowsLocalGateOutputDir(steps)
  if (outputDir) {
    lines.push(`evidence output: ${outputDir}`)
    lines.push(`run manifest: ${windowsLocalGateManifestPath({ outputDir })}`)
    lines.push(
      `support bundle verifier: ${windowsSupportBundleVerifierCommand({
        bundlePath: join(outputDir, 'support-bundle.json')
      }).join(' ')}`
    )
    lines.push('acceptance template: docs/acceptance/windows-app-acceptance-template.md')
  }
  if (host.ok) {
    lines.push('[ok] host: Windows 11 x64 gate host')
  } else {
    for (const failure of host.failures) {
      lines.push(`[blocked] host: ${failure}`)
    }
  }

  for (const [index, step] of steps.entries()) {
    const env = step.env
      ? ` (${Object.keys(step.env)
          .map((name) => `${name}=${step.env[name]}`)
          .join(', ')})`
      : ''
    lines.push(`${index + 1}. ${step.label}: ${step.command} ${step.args.join(' ')}${env}`)
  }

  return lines.join('\n')
}

export function windowsLocalGateOutputDir(steps) {
  const packagedSmoke = steps.find(
    (step) => step.label === 'packaged recording and bundled-background smoke'
  )
  if (packagedSmoke?.env?.VIDEORC_SMOKE_OUTPUT_DIR) {
    return packagedSmoke.env.VIDEORC_SMOKE_OUTPUT_DIR
  }
  return steps.find((step) => step.env?.VIDEORC_SMOKE_OUTPUT_DIR)?.env?.VIDEORC_SMOKE_OUTPUT_DIR
}

export function windowsLocalGateManifestPath({ outputDir }) {
  if (!outputDir) {
    throw new Error('outputDir is required.')
  }
  return join(outputDir, WINDOWS_LOCAL_GATE_MANIFEST_NAME)
}

export function createWindowsLocalGateManifest({
  host,
  steps,
  repoRoot,
  candidateIdentity = null,
  outputDir = windowsLocalGateOutputDir(steps),
  platform = process.platform,
  arch = process.arch,
  release = '',
  startedAt = new Date()
} = {}) {
  if (!host) {
    throw new Error('host is required.')
  }
  if (!Array.isArray(steps)) {
    throw new Error('steps are required.')
  }
  if (!repoRoot) {
    throw new Error('repoRoot is required.')
  }
  if (!outputDir) {
    throw new Error('outputDir is required.')
  }

  return {
    schemaVersion: 1,
    kind: 'windows-local-gates',
    status: host.ok ? 'pending' : 'blocked',
    startedAt: toIsoString(startedAt),
    finishedAt: null,
    repoRoot,
    candidateIdentity,
    host: {
      ok: host.ok,
      platform,
      arch,
      release,
      build: host.build,
      failures: [...host.failures]
    },
    evidence: {
      outputDir,
      runManifest: windowsLocalGateManifestPath({ outputDir }),
      supportBundleVerifierCommand: windowsSupportBundleVerifierCommand({
        bundlePath: join(outputDir, 'support-bundle.json')
      }),
      acceptanceTemplate: join(
        repoRoot,
        'docs',
        'acceptance',
        'windows-app-acceptance-template.md'
      ),
      generatedArtifactsRoot: join(repoRoot, 'docs', 'acceptance', 'artifacts', 'windows')
    },
    steps: steps.map((step, index) => ({
      index: index + 1,
      label: step.label,
      command: step.command,
      args: [...step.args],
      env: step.env ? { ...step.env } : {},
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      error: null
    }))
  }
}

export function windowsSupportBundleVerifierCommand({ bundlePath = '<support-bundle.json>' } = {}) {
  return ['pnpm', 'support-bundle:verify', '--', bundlePath, '--windows-acceptance']
}

function defaultWindowsAcceptanceArtifactDir({ repoRoot }) {
  const date = new Date().toISOString().slice(0, 10)
  return join(repoRoot, 'docs', 'acceptance', 'artifacts', 'windows', date)
}

function windowsBuildNumber(release) {
  if (typeof release !== 'string' || !release.trim()) {
    return null
  }
  const build = Number(release.split('.')[2])
  return Number.isFinite(build) ? build : null
}

function toIsoString(value) {
  if (value instanceof Date) {
    return value.toISOString()
  }
  return new Date(value).toISOString()
}

function lowercaseSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
