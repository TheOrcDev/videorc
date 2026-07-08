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
      label: 'packaged boot plus test-pattern recording smoke',
      command: 'pnpm',
      args: ['smoke:packaged:bundled'],
      env: {
        VIDEORC_PACKAGED_APP_EXECUTABLE: executable,
        VIDEORC_SMOKE_OUTPUT_DIR: outputDir
      }
    }
  ]
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
    (step) => step.label === 'packaged boot plus test-pattern recording smoke'
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
