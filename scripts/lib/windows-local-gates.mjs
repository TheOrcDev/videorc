import { dirname, join, resolve } from 'node:path'

export const WINDOWS_LOCAL_GATE_MANIFEST_NAME = 'windows-local-gates.manifest.json'

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
    if (sensitiveName.test(name)) {
      delete sanitized[name]
    }
  }
  return sanitized
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
      label: 'native Windows ScreenOnly and BMP smoke',
      command: 'pnpm',
      args: ['smoke:windows-native-screen'],
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
      label: 'recording-time Windows proof-surface smoke',
      command: 'pnpm',
      args: ['smoke:recording-native-preview'],
      env: {
        VIDEORC_PERF_APP_EXECUTABLE: executable,
        VIDEORC_SMOKE_OUTPUT_DIR: join(outputDir, 'proof-preview'),
        VIDEORC_SMOKE_FFMPEG_PATH: packagedFfmpeg,
        VIDEORC_SMOKE_FFPROBE_PATH: packagedFfprobe,
        VIDEORC_SMOKE_TIMEOUT_MS: '180000',
        VIDEORC_NATIVE_PREVIEW_RECORDING_MS: '8000',
        VIDEORC_NATIVE_PREVIEW_WARMUP_MS: '2000',
        VIDEORC_NATIVE_PREVIEW_MEASUREMENT_MS: '4000',
        VIDEORC_EXPECT_NATIVE_METAL_PREVIEW: '0',
        VIDEORC_NATIVE_PREVIEW_EXERCISE_PROOF_POLLING: '1',
        VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'raw-yuv420p'
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
