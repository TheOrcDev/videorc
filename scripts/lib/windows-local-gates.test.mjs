import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  assertInstalledWindowsCandidateIdentity,
  buildWindowsLocalGateSteps,
  classifyWindowsLocalGateStepExit,
  createWindowsLocalGateManifest,
  evaluateWindowsLocalGateHost,
  formatWindowsLocalGatePlan,
  sanitizeWindowsLocalGateChildEnvironment,
  windowsSupportBundleVerifierCommand,
  windowsLocalGateManifestPath,
  windowsLocalGateOutputDir
} from './windows-local-gates.mjs'

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
    assert.deepEqual(
      sanitizeWindowsLocalGateChildEnvironment({
        AZURE_CLIENT_SECRET: 'secret',
        VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID: 'secret',
        VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN: 'secret',
        VIDEORC_WINDOWS_SIGNING_ACCOUNT_NAME: 'secret',
        VIDEORC_RELEASE_ID: '0.9.45-alpha.1',
        PATH: 'safe'
      }),
      { VIDEORC_RELEASE_ID: '0.9.45-alpha.1', PATH: 'safe' }
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
      'backend capture-input seam tests',
      'backend FIFO seam tests',
      'owned process lifecycle cleanup smoke',
      'build release backend',
      'fetch pinned Windows FFmpeg',
      'Windows package preflight',
      'package desktop Windows dir',
      'packaged recording and bundled-background smoke',
      'native Windows ScreenOnly and BMP smoke',
      'recording-time Windows proof-surface smoke',
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
    assert.deepEqual(steps.at(-4).args, ['smoke:windows-native-screen'])
    assert.deepEqual(steps.at(-3).args, ['smoke:recording-native-preview'])
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
