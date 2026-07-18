import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

import {
  assertInstalledWindowsCandidateIdentity,
  buildWindowsLocalGateSteps,
  classifyWindowsLocalGateStepExit,
  createWindowsLocalGateManifest,
  evaluateWindowsLocalGateHost,
  formatWindowsLocalGatePlan,
  sanitizeWindowsLocalGateChildEnvironment,
  windowsLocalGateOutputDir
} from './lib/windows-local-gates.mjs'
import { sha256File } from './lib/windows-alpha-release.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const dryRun = process.argv.includes('--dry-run') || process.argv.includes('--print-only')
const startedAt = new Date()
const installedCandidateExecutable = process.env.VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE?.trim()
const requireInstalledCandidate = process.env.VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED === '1'
const host = evaluateWindowsLocalGateHost({
  release: release(),
  // Same dev/lab escape hatch as the app's startup floor: lets Windows 10
  // boxes run the gates as an unsupported configuration.
  allowUnsupportedBuild:
    !requireInstalledCandidate && process.env.VIDEORC_ALLOW_UNSUPPORTED_WINDOWS === '1',
  requireKnownBuild: requireInstalledCandidate
})
let candidateIdentity = null
if (requireInstalledCandidate && !installedCandidateExecutable) {
  host.ok = false
  host.failures.push(
    'release acceptance requires VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE pointing at the installed signed candidate'
  )
}
if (installedCandidateExecutable && !requireInstalledCandidate) {
  host.ok = false
  host.failures.push(
    'VIDEORC_WINDOWS_ACCEPTANCE_EXECUTABLE requires VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED=1'
  )
}
if (requireInstalledCandidate && installedCandidateExecutable) {
  try {
    candidateIdentity = await inspectInstalledCandidateIdentity(installedCandidateExecutable)
  } catch (error) {
    host.ok = false
    host.failures.push(
      `installed candidate identity verification failed: ${error?.message ?? 'unexpected error'}`
    )
  }
}
const steps = buildWindowsLocalGateSteps({
  repoRoot,
  packagedAppExecutable: installedCandidateExecutable,
  useExistingCandidate: requireInstalledCandidate,
  acceptanceDir: process.env.VIDEORC_WINDOWS_ACCEPTANCE_DIR
})
const outputDir = windowsLocalGateOutputDir(steps)
const manifest = createWindowsLocalGateManifest({
  host,
  steps,
  repoRoot,
  candidateIdentity,
  outputDir,
  platform: process.platform,
  arch: process.arch,
  release: release(),
  startedAt
})
const childEnvironment = sanitizeWindowsLocalGateChildEnvironment(process.env)

console.log(formatWindowsLocalGatePlan({ host, steps }))

if (dryRun) {
  process.exit(0)
}

await mkdir(outputDir, { recursive: true })
await writeManifest()
console.log(`windows-local-gates: manifest ${manifest.evidence.runManifest}`)

if (!host.ok) {
  manifest.status = 'blocked'
  manifest.finishedAt = new Date().toISOString()
  await writeManifest()
  process.exit(1)
}

let blockedStep = null
for (const [index, step] of steps.entries()) {
  const manifestStep = manifest.steps[index]
  const stepStartedAt = Date.now()
  manifestStep.status = 'running'
  manifestStep.startedAt = new Date(stepStartedAt).toISOString()
  await writeManifest()

  try {
    manifestStep.status = await runStep(step)
    if (manifestStep.status === 'blocked') {
      blockedStep = step
      manifest.status = 'blocked'
      manifestStep.error = { message: await blockedStepReason(step) }
    }
  } catch (error) {
    manifestStep.status = 'failed'
    manifestStep.error = {
      message: error?.message ?? String(error)
    }
    manifest.status = 'failed'
    manifest.finishedAt = new Date().toISOString()
    throw error
  } finally {
    manifestStep.finishedAt = new Date().toISOString()
    manifestStep.durationMs = Date.now() - stepStartedAt
    await writeManifest()
  }
  if (blockedStep) break
}

if (blockedStep) {
  manifest.finishedAt = new Date().toISOString()
  await writeManifest()
  console.error(`windows-local-gates: BLOCKED at ${blockedStep.label}`)
  process.exitCode = blockedStep.blockedExitCode
} else {
  manifest.status = 'passed'
  manifest.finishedAt = new Date().toISOString()
  await writeManifest()
  console.log('windows-local-gates: PASS')
}

function runStep(step) {
  return new Promise((resolveStep, rejectStep) => {
    console.log(`\n[windows-local-gates] ${step.label}`)
    const child = spawn(step.command, step.args, {
      cwd: repoRoot,
      env: {
        ...childEnvironment,
        ...step.env
      },
      shell: process.platform === 'win32',
      stdio: 'inherit'
    })

    child.on('error', rejectStep)
    child.on('exit', (code, signal) => {
      const outcome = classifyWindowsLocalGateStepExit(step, code)
      if (outcome === 'passed') {
        resolveStep('passed')
        return
      }
      if (outcome === 'blocked') {
        resolveStep('blocked')
        return
      }
      rejectStep(
        new Error(
          `${step.label} failed: ${step.command} ${step.args.join(' ')} exited with code=${code} signal=${signal}`
        )
      )
    })
  })
}

function writeManifest() {
  return writeFile(manifest.evidence.runManifest, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function blockedStepReason(step) {
  if (step.blockedReportPath) {
    try {
      const report = JSON.parse(await readFile(step.blockedReportPath, 'utf8'))
      if (report?.status === 'blocked' && typeof report?.error?.message === 'string') {
        return report.error.message
      }
    } catch {
      // Fall through to the stable parent-level reason when evidence is unreadable.
    }
  }
  return `${step.label} reported a blocked physical-device prerequisite.`
}

async function inspectInstalledCandidateIdentity(executablePath) {
  if (process.platform !== 'win32') {
    throw new Error('installed candidate identity can only be verified on Windows')
  }
  const stagingRoot = resolve(repoRoot, 'apps', 'desktop', 'release')
  const resolvedExecutable = resolve(executablePath)
  const stagingRelative = relative(stagingRoot, resolvedExecutable)
  if (!stagingRelative.startsWith('..') && !isAbsolute(stagingRelative)) {
    throw new Error('release staging files cannot substitute for an NSIS-installed candidate')
  }
  const facts = readInstalledExecutableFacts(executablePath)
  return assertInstalledWindowsCandidateIdentity({
    executablePath,
    releaseId: requiredEnv('VIDEORC_RELEASE_ID'),
    sourceCommit: requiredEnv('VIDEORC_RELEASE_SOURCE_COMMIT'),
    installerSha256: requiredEnv('VIDEORC_RELEASE_EXPECTED_SHA256'),
    expectedAppSha256: requiredEnv('VIDEORC_WINDOWS_ACCEPTANCE_EXPECTED_APP_SHA256'),
    actualAppSha256: await sha256File(executablePath),
    expectedPublisher: requiredEnv('VIDEORC_WINDOWS_PUBLISHER_NAME'),
    signature: facts.signature,
    productVersion: facts.productVersion,
    registration: facts.registration
  })
}

function readInstalledExecutableFacts(executablePath) {
  const script = [
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
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: { ...process.env, VIDEORC_SIGNATURE_TARGET: executablePath }
    }
  )
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error('PowerShell could not read installed executable identity and signature facts.')
  }
  return JSON.parse(result.stdout.trim())
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}
