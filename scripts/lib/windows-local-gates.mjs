import { join, resolve } from 'node:path'

export const WINDOWS_LOCAL_GATE_MANIFEST_NAME = 'windows-local-gates.manifest.json'

export function evaluateWindowsLocalGateHost({
  platform = process.platform,
  arch = process.arch,
  release = '',
  allowUnsupportedBuild = false
} = {}) {
  const failures = []
  if (platform !== 'win32') {
    failures.push(`requires Windows 11 x64; current platform is ${platform}`)
  }
  if (arch !== 'x64') {
    failures.push(`requires x64 architecture; current architecture is ${arch}`)
  }

  const build = windowsBuildNumber(release)
  if (platform === 'win32' && build !== null && build < 22000 && !allowUnsupportedBuild) {
    failures.push(`requires Windows 11 build 22000 or newer; current build is ${build}`)
  }

  return {
    ok: failures.length === 0,
    failures,
    build
  }
}

export function buildWindowsLocalGateSteps({
  repoRoot,
  packagedAppExecutable,
  acceptanceDir
} = {}) {
  if (!repoRoot) {
    throw new Error('repoRoot is required.')
  }
  const executable =
    packagedAppExecutable ?? resolve(repoRoot, 'apps/desktop/release/win-unpacked/Videorc.exe')
  const packagedFfmpeg = resolve(
    repoRoot,
    'apps/desktop/release/win-unpacked/resources/ffmpeg/bin/ffmpeg.exe'
  )
  const packagedFfprobe = resolve(
    repoRoot,
    'apps/desktop/release/win-unpacked/resources/ffmpeg/bin/ffprobe.exe'
  )
  const outputDir = acceptanceDir
    ? resolve(repoRoot, acceptanceDir)
    : defaultWindowsAcceptanceArtifactDir({ repoRoot })

  return [
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
    },
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
    },
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
        VIDEORC_WINDOWS_SUPPORT_BUNDLE_PATH: join(outputDir, 'support-bundle.json')
      }
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
