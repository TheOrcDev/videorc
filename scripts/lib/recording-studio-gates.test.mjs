import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  buildRecordingStudioGateSteps,
  formatRecordingStudioGatePlan
} from './recording-studio-gates.mjs'

describe('buildRecordingStudioGateSteps', () => {
  it('covers studio unit tests, script A/V tests, backend studio modules, and app smoke', () => {
    const steps = buildRecordingStudioGateSteps()
    const labels = steps.map((step) => step.label)

    assert.deepEqual(labels, [
      'desktop recording studio unit tests',
      'script artifact analyzer and A/V sync tests',
      'backend live layout tests',
      'backend scene layout tests',
      'backend recording pipeline tests',
      'backend audio pipeline tests',
      'backend noise cleanup tests',
      'live captions transport contract smoke',
      'live captions mute/gain and record+stream artifact smoke',
      'noise cleanup final-artifact smoke',
      'dev app all-layout recording artifact smoke',
      'imported screen image recording smoke',
      'real-user launch first-frame contract smoke',
      'layout/source preview liveness smoke',
      'active-session live layout switch recording smoke',
      'comment highlight stream artifact smoke',
      'backend-owned preview scene commit smoke',
      'preview main pump diagnostics smoke',
      'preview click/focus continuity smoke',
      'preview interaction stress smoke',
      'detached preview lifecycle probe',
      'preview window placement + docked stick probe',
      'detached native preview surface reattach smoke',
      'real ScreenCaptureKit screen recording smoke',
      'Notes window recording invisibility smoke'
    ])
    assert.deepEqual(steps[0].args, [
      '--filter',
      '@videorc/desktop',
      'test',
      'capture.test.ts',
      'caption-overlay.test.ts',
      'captions-ui.test.ts',
      'background-assets.test.ts',
      'session-params.test.ts',
      'studio-health.test.ts',
      'noise-cleanup-view.test.ts',
      'library-noise-cleanup.test.ts',
      'studio-provider.integration.test.ts',
      'backend-rpc-contract.test.ts',
      'native-preview-present-policy.test.ts',
      'native-preview-first-frame.test.ts',
      'backend-isolation.test.ts'
    ])
    assert.deepEqual(steps[1].args, ['test:scripts'])
    assert.deepEqual(steps.at(-18).args, ['smoke:captions-contract'])
    assert.deepEqual(steps.at(-17).args, ['smoke:captions-live'])
    assert.deepEqual(steps.at(-16).args, ['smoke:noise-cleanup'])
    assert.deepEqual(steps.at(-15).args, ['smoke:dev'])
    assert.deepEqual(steps.at(-14).args, ['smoke:screens'])
    assert.deepEqual(steps.at(-13).args, ['smoke:preview-real-launch'])
    assert.deepEqual(steps.at(-12).args, ['smoke:layout-source-loop'])
    assert.deepEqual(steps.at(-11).args, ['smoke:live-layout-switch-recording'])
    assert.deepEqual(steps.at(-10).args, ['smoke:comment-highlight-stream'])
    assert.deepEqual(steps.at(-9).args, ['smoke:preview-scene-commit'])
    assert.deepEqual(steps.at(-8).args, ['smoke:preview-pump-diagnostics'])
    assert.deepEqual(steps.at(-7).args, ['smoke:preview-click-focus'])
    assert.deepEqual(steps.at(-6).args, ['smoke:preview-interaction-stress'])
    assert.deepEqual(steps.at(-5).args, ['probe:preview-lifecycle'])
    assert.deepEqual(steps.at(-4).args, ['probe:preview-window'])
    assert.deepEqual(steps.at(-3).args, ['smoke:preview-surface'])
    assert.equal(steps.at(-3).env.VIDEORC_PREVIEW_SURFACE_MIN_FPS, '30')
    assert.equal(steps.at(-3).env.VIDEORC_PREVIEW_SURFACE_MAX_INTERVAL_P95_MS, '120')
    assert.equal(steps.at(-3).env.VIDEORC_PREVIEW_SURFACE_MAX_INPUT_TO_PRESENT_P95_MS, '100')
    assert.deepEqual(steps.at(-2).args, ['smoke:screen-recording-real'])
    assert.equal(steps.at(-2).env.VIDEORC_BASELINE_SOURCE_READINESS_MS, '60000')
    assert.deepEqual(steps.at(-1).args, ['smoke:notes-window-invisible'])
    assert.equal(steps.at(-1).env.VIDEORC_BASELINE_SOURCE_READINESS_MS, '60000')
  })

  it('can include the heavier native preview layout-stress smoke', () => {
    const steps = buildRecordingStudioGateSteps({ includeDeviceSmoke: true })
    const interactionDeviceSmoke = steps.at(-3)
    const liveLayoutDeviceSmoke = steps.at(-2)
    const deviceSmoke = steps.at(-1)

    assert.equal(
      interactionDeviceSmoke.label,
      'real-device preview interaction and recording artifact smoke'
    )
    assert.deepEqual(interactionDeviceSmoke.args, ['smoke:preview-interaction-stress:devices'])
    assert.equal(
      liveLayoutDeviceSmoke.label,
      'real ScreenCaptureKit live layout switch recording smoke'
    )
    assert.deepEqual(liveLayoutDeviceSmoke.args, ['smoke:live-layout-switch-recording:devices'])
    assert.equal(deviceSmoke.label, 'native preview source-complete layout stress recording smoke')
    assert.deepEqual(deviceSmoke.args, ['smoke:recording-native-preview'])
    assert.equal(deviceSmoke.env.VIDEORC_NATIVE_PREVIEW_SOURCE_COMPLETE_SCENE, '1')
    assert.equal(deviceSmoke.env.VIDEORC_NATIVE_PREVIEW_LAYOUT_STRESS_UPDATES, '4')
  })

  it('formats commands for dry-run evidence', () => {
    const report = formatRecordingStudioGatePlan({
      steps: buildRecordingStudioGateSteps({ includeDeviceSmoke: true })
    })

    assert.match(report, /recording-studio-gates: plan/)
    assert.match(report, /capture\.test\.ts/)
    assert.match(report, /test:scripts/)
    assert.match(report, /live_layout::tests::/)
    assert.match(report, /smoke:captions-contract/)
    assert.match(report, /smoke:captions-live/)
    assert.match(report, /noise_cleanup::tests::/)
    assert.match(report, /smoke:noise-cleanup/)
    assert.match(report, /smoke:dev/)
    assert.match(report, /smoke:screens/)
    assert.match(report, /smoke:layout-source-loop/)
    assert.match(report, /smoke:live-layout-switch-recording/)
    assert.match(report, /smoke:comment-highlight-stream/)
    assert.match(report, /smoke:preview-scene-commit/)
    assert.match(report, /smoke:preview-pump-diagnostics/)
    assert.match(report, /smoke:preview-click-focus/)
    assert.match(report, /smoke:preview-interaction-stress/)
    assert.match(report, /probe:preview-lifecycle/)
    assert.match(report, /probe:preview-window/)
    assert.match(report, /smoke:preview-surface/)
    assert.match(report, /smoke:screen-recording-real/)
    assert.match(report, /VIDEORC_BASELINE_SOURCE_READINESS_MS=60000/)
    assert.match(report, /smoke:notes-window-invisible/)
    assert.match(report, /VIDEORC_PREVIEW_SURFACE_MAX_INPUT_TO_PRESENT_P95_MS=100/)
    assert.match(report, /VIDEORC_NATIVE_PREVIEW_SOURCE_COMPLETE_SCENE=1/)
    assert.match(report, /VIDEORC_NATIVE_PREVIEW_LAYOUT_STRESS_UPDATES=4/)
    assert.match(report, /pnpm smoke:live-layout-switch-recording:devices/)
    assert.match(report, /pnpm smoke:preview-interaction-stress:devices/)
    assert.match(report, /pnpm smoke:recording-native-preview/)
  })

  it('keeps normal and device interaction-stress entrypoints available', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    )

    assert.equal(
      packageJson.scripts['smoke:preview-interaction-stress'],
      'node scripts/smoke-preview-interaction-stress-app.mjs'
    )
    assert.equal(
      packageJson.scripts['smoke:preview-interaction-stress:devices'],
      'node scripts/run-with-env.mjs --platform=darwin VIDEORC_PREVIEW_INTERACTION_DEVICE_SMOKE=1 -- node scripts/smoke-preview-interaction-stress-app.mjs'
    )
    assert.equal(packageJson.scripts['smoke:noise-cleanup'], 'node scripts/smoke-noise-cleanup.mjs')
    assert.equal(
      packageJson.scripts['smoke:noise-cleanup:bundled'],
      'node scripts/smoke-noise-cleanup.mjs --require-bundled'
    )

    for (const relativePath of [
      '../preflight-macos-package.mjs',
      '../preflight-windows-package.mjs'
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
      assert.match(source, /smoke-noise-cleanup\.mjs/)
      assert.match(source, /--require-bundled/)
      assert.match(source, /pcm_s16le/)
    }
  })

  it('waits for the finalized MP4 before analyzing the device interaction recording', () => {
    const source = readFileSync(
      new URL('../smoke-preview-interaction-stress-app.mjs', import.meta.url),
      'utf8'
    )

    assert.match(
      source,
      /import \{ resolveFinalRecordingPath \} from '.\/lib\/final-recording-path\.mjs'/
    )
    assert.match(source, /await resolveFinalRecordingPath\(\{/)
  })
})
