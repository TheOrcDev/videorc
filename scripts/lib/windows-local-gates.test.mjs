import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  buildWindowsLocalGateSteps,
  classifyWindowsLocalGateStepExit,
  createWindowsLocalGateManifest,
  evaluateWindowsLocalGateHost,
  formatWindowsLocalGatePlan,
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
      'physical Windows live microphone controls smoke'
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
    assert.deepEqual(steps.at(-3).args, ['smoke:windows-native-screen'])
    assert.deepEqual(steps.at(-2).args, ['smoke:recording-native-preview'])
    assert.deepEqual(steps.at(-1).args, ['smoke:windows-live-audio-controls'])
    assert.equal(steps.at(-1).blockedExitCode, 2)
    assert.match(
      posixPath(steps.at(-1).blockedReportPath),
      /live-audio-controls\/windows-live-audio-controls\.json$/
    )
    assert.match(
      posixPath(steps.at(-1).env.VIDEORC_WINDOWS_SUPPORT_BUNDLE_PATH),
      /C:\/repo\/docs\/acceptance\/artifacts\/windows\/\d{4}-\d{2}-\d{2}\/support-bundle\.json$/
    )
    assert.match(
      posixPath(windowsLocalGateOutputDir(steps)),
      /C:\/repo\/docs\/acceptance\/artifacts\/windows\/\d{4}-\d{2}-\d{2}$/
    )
  })

  it('preserves an explicit physical-device blocker instead of reporting a failure', () => {
    const step = buildWindowsLocalGateSteps({ repoRoot: 'C:/repo' }).at(-1)

    assert.equal(classifyWindowsLocalGateStepExit(step, 0), 'passed')
    assert.equal(classifyWindowsLocalGateStepExit(step, 2), 'blocked')
    assert.equal(classifyWindowsLocalGateStepExit(step, 1), 'failed')
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
