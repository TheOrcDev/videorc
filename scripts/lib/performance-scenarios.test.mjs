import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolve } from 'node:path'

import {
  buildPerformanceScenario,
  MACOS_PERFORMANCE_POWER_ASSERTION,
  performanceScenarioLaunchSpec,
  performanceScenarioReportPaths
} from './performance-scenarios.mjs'

describe('buildPerformanceScenario', () => {
  it('keeps native and JPEG fallback scenarios unmistakably separate', () => {
    const native = buildPerformanceScenario({
      scenario: 'detached-native-preview',
      mode: 'gate',
      warmupSeconds: 60,
      measurementSeconds: 600,
      childReportPath: '/tmp/native.json',
      runNonce: 'native-run',
      expectedBuildMode: 'packaged',
      node: 'node'
    })
    const fallback = buildPerformanceScenario({
      scenario: 'jpeg-fallback',
      mode: 'gate',
      warmupSeconds: 2,
      measurementSeconds: 5,
      childReportPath: '/tmp/fallback.json',
      node: 'node'
    })

    assert.deepEqual(native.args, ['scripts/perf-idle-probe.mjs', '--gate'])
    assert.equal(native.env.VIDEORC_PERF_PREVIEW_MODE, 'detached')
    assert.equal(native.env.VIDEORC_PERF_APP_ROLE, 'detached-native-preview')
    assert.equal(native.env.VIDEORC_PERF_SOURCE_FPS, '60')
    assert.equal(native.env.VIDEORC_PERF_RUN_NONCE, 'native-run')
    assert.equal(native.env.VIDEORC_PERF_EXPECT_BUILD_MODE, 'packaged')
    assert.deepEqual(fallback.args, ['scripts/smoke-preview-performance-app.mjs', '--gate'])
    assert.equal(fallback.env.VIDEORC_PREVIEW_EXPECT_TRANSPORT, 'latest-jpeg-polling')
    assert.equal(fallback.env.VIDEORC_PREVIEW_EXPECT_BACKING, 'none')
  })

  it('marks real 4K scenarios as device-required and carries endurance timing', () => {
    const scenario = buildPerformanceScenario({
      scenario: 'record-4k-stream-1080p',
      mode: 'gate',
      warmupSeconds: 60,
      measurementSeconds: 600,
      childReportPath: '/tmp/split.json'
    })

    assert.equal(scenario.deviceRequired, true)
    assert.deepEqual(scenario.args, ['baseline:stream:split-output-4k-record:base', '--gate'])
    assert.equal(scenario.env.VIDEORC_BASELINE_RECORDING_MS, '660000')
    assert.equal(scenario.env.VIDEORC_BASELINE_NO_PREVIEW_SURFACE, '0')
    assert.equal(scenario.env.VIDEORC_PERF_EXPECT_TRANSPORT, 'native-surface')
    assert.equal(scenario.env.VIDEORC_PERF_EXPECT_BACKING, 'cametal-layer')
    assert.equal(scenario.env.VIDEORC_PERF_APP_ROLE, 'recording+streaming')
    assert.deepEqual(JSON.parse(scenario.env.VIDEORC_PERF_OUTPUTS_JSON), [
      { role: 'recording', width: 3840, height: 2160, fps: 30 },
      { role: 'streaming', width: 1920, height: 1080, fps: 30 }
    ])
  })

  it('uses the real-source harness for truthful screen, camera, and microphone coverage', () => {
    const scenario = buildPerformanceScenario({
      scenario: 'real-devices-1080p',
      mode: 'gate',
      warmupSeconds: 60,
      measurementSeconds: 600,
      childReportPath: '/tmp/real-devices.json'
    })

    assert.equal(scenario.deviceRequired, true)
    assert.deepEqual(scenario.args, ['baseline:real-source', '--gate'])
    assert.equal(scenario.env.VIDEORC_BASELINE_RECORDING_MS, '660000')
    assert.equal(scenario.env.VIDEORC_PERF_APP_ROLE, 'real-screen-camera-microphone-recording')
    assert.equal(scenario.env.VIDEORC_BASELINE_NO_PREVIEW_SURFACE, '0')
    assert.equal(scenario.env.VIDEORC_PERF_EXPECT_TRANSPORT, 'native-surface')
  })

  it('runs record-only acceptance in gate mode', () => {
    const scenario = buildPerformanceScenario({
      scenario: 'record-4k',
      mode: 'gate',
      warmupSeconds: 60,
      measurementSeconds: 600,
      childReportPath: '/tmp/record.json'
    })

    assert.deepEqual(scenario.args, ['baseline:real-source:4k30', '--gate'])
    assert.equal(scenario.env.VIDEORC_BASELINE_RECORDING_MS, '660000')
    assert.equal(scenario.env.VIDEORC_BASELINE_NO_PREVIEW_SURFACE, '0')
    assert.equal(scenario.env.VIDEORC_PERF_EXPECT_BACKING, 'cametal-layer')
  })

  it('defines representative 1080p60 and vertical 4K30 recording endurance workloads', () => {
    const fullHd = buildPerformanceScenario({
      scenario: 'record-1080p60',
      mode: 'gate',
      warmupSeconds: 60,
      measurementSeconds: 600,
      childReportPath: '/tmp/1080p60.json'
    })
    const vertical = buildPerformanceScenario({
      scenario: 'record-vertical-4k30',
      mode: 'gate',
      warmupSeconds: 60,
      measurementSeconds: 600,
      childReportPath: '/tmp/vertical-4k30.json'
    })

    assert.deepEqual(fullHd.args, ['baseline:real-source', '--gate'])
    assert.equal(fullHd.env.VIDEORC_BASELINE_WIDTH, '1920')
    assert.equal(fullHd.env.VIDEORC_BASELINE_HEIGHT, '1080')
    assert.equal(fullHd.env.VIDEORC_BASELINE_FPS, '60')
    assert.equal(fullHd.env.VIDEORC_BASELINE_RECORDING_MS, '660000')
    assert.deepEqual(JSON.parse(fullHd.env.VIDEORC_PERF_OUTPUTS_JSON), [
      { role: 'recording', width: 1920, height: 1080, fps: 60 }
    ])

    assert.deepEqual(vertical.args, ['baseline:real-source', '--gate'])
    assert.equal(vertical.env.VIDEORC_BASELINE_WIDTH, '2160')
    assert.equal(vertical.env.VIDEORC_BASELINE_HEIGHT, '3840')
    assert.equal(vertical.env.VIDEORC_BASELINE_FPS, '30')
    assert.deepEqual(JSON.parse(vertical.env.VIDEORC_PERF_OUTPUTS_JSON), [
      { role: 'recording', width: 2160, height: 3840, fps: 30 }
    ])
  })

  it('defines packaged Windows proof-surface recording calibration at 1080p and 4K', () => {
    const fullHd = buildPerformanceScenario({
      scenario: 'windows-proof-recording-1080p',
      mode: 'report-only',
      warmupSeconds: 60,
      measurementSeconds: 600,
      childReportPath: '/tmp/windows-1080p.json',
      node: 'node'
    })
    const fourK = buildPerformanceScenario({
      scenario: 'windows-proof-recording-4k',
      mode: 'report-only',
      warmupSeconds: 60,
      measurementSeconds: 600,
      childReportPath: '/tmp/windows-4k.json',
      node: 'node'
    })

    assert.equal(fullHd.deviceRequired, true)
    assert.deepEqual(fullHd.args, ['scripts/smoke-windows-native-screen-app.mjs'])
    assert.equal(fullHd.env.VIDEORC_WINDOWS_NATIVE_SCREEN_RECORDING_MS, '660000')
    assert.equal(fullHd.env.VIDEORC_SMOKE_VIDEO_WIDTH, '1920')
    assert.equal(fullHd.env.VIDEORC_SMOKE_VIDEO_HEIGHT, '1080')
    assert.equal(fullHd.env.VIDEORC_PERF_APP_ROLE, 'windows-proof-surface-recording')
    assert.equal(fourK.env.VIDEORC_SMOKE_VIDEO_WIDTH, '3840')
    assert.equal(fourK.env.VIDEORC_SMOKE_VIDEO_HEIGHT, '2160')
    assert.equal(fourK.env.VIDEORC_SMOKE_VIDEO_BITRATE_KBPS, '30000')
  })

  it('defines live Studio mic visuals and explicit lifecycle-churn workloads', () => {
    const mic = buildPerformanceScenario({
      scenario: 'studio-live-mic-visuals',
      mode: 'gate',
      warmupSeconds: 60,
      measurementSeconds: 600,
      childReportPath: '/tmp/mic.json',
      node: 'node'
    })
    const churn = buildPerformanceScenario({
      scenario: 'lifecycle-churn',
      mode: 'gate',
      childReportPath: '/tmp/churn.json',
      node: 'node'
    })

    assert.deepEqual(mic.args, ['scripts/perf-idle-probe.mjs', '--gate'])
    assert.equal(mic.env.VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS, '1')
    assert.equal(mic.env.VIDEORC_PERF_PREVIEW_MODE, 'docked')
    assert.equal(mic.deviceRequired, true)
    assert.deepEqual(churn.args, ['scripts/preview-lifecycle-probe.mjs'])
    assert.equal(churn.timing.cycles, 200)
  })

  it('keeps split-output report-only mode neutral through the package script', () => {
    const scenario = buildPerformanceScenario({
      scenario: 'record-4k-stream-1080p',
      mode: 'report-only',
      childReportPath: '/tmp/split-report.json'
    })

    assert.deepEqual(scenario.args, [
      'baseline:stream:split-output-4k-record:base',
      '--report-only'
    ])
  })

  it('rejects unknown scenarios', () => {
    assert.throws(
      () =>
        buildPerformanceScenario({
          scenario: 'mystery',
          mode: 'gate',
          childReportPath: '/tmp/nope.json'
        }),
      /Unknown performance scenario/
    )
  })
})

describe('performanceScenarioReportPaths', () => {
  it('derives a child report next to an explicit wrapper report', () => {
    assert.deepEqual(
      performanceScenarioReportPaths({ scenario: 'ui-idle', outputPath: '/tmp/result.json' }),
      { wrapper: resolve('/tmp/result.json'), child: resolve('/tmp/result.child.json') }
    )
  })

  it('keeps wrapper and child paths distinct when output has no json suffix', () => {
    assert.deepEqual(
      performanceScenarioReportPaths({ scenario: 'ui-idle', outputPath: '/tmp/result' }),
      { wrapper: resolve('/tmp/result'), child: resolve('/tmp/result.child.json') }
    )
  })
})

describe('performanceScenarioLaunchSpec', () => {
  const scenario = {
    command: 'node',
    args: ['scripts/perf-idle-probe.mjs', '--gate'],
    env: { VIDEORC_PERF_SCENARIO: 'detached-native-preview' }
  }

  it('holds and records display plus system sleep assertions on macOS', () => {
    const launch = performanceScenarioLaunchSpec(scenario, {
      platform: 'darwin',
      caffeinatePath: '/usr/bin/caffeinate'
    })

    assert.equal(launch.command, '/usr/bin/caffeinate')
    assert.deepEqual(launch.args, [
      '-d',
      '-i',
      '-s',
      'node',
      'scripts/perf-idle-probe.mjs',
      '--gate'
    ])
    assert.equal(launch.env.VIDEORC_PERF_POWER_ASSERTION, MACOS_PERFORMANCE_POWER_ASSERTION)
    assert.deepEqual(launch.powerAssertion, {
      provider: 'caffeinate',
      flags: ['-d', '-i', '-s']
    })
  })

  it('leaves non-macOS commands unchanged and records no false assertion', () => {
    const launch = performanceScenarioLaunchSpec(
      {
        ...scenario,
        env: { ...scenario.env, VIDEORC_PERF_POWER_ASSERTION: 'ambient-false-claim' }
      },
      { platform: 'win32' }
    )

    assert.equal(launch.command, scenario.command)
    assert.deepEqual(launch.args, scenario.args)
    assert.equal(launch.env.VIDEORC_PERF_SCENARIO, 'detached-native-preview')
    assert.equal(launch.env.VIDEORC_PERF_POWER_ASSERTION, '')
    assert.equal(launch.powerAssertion, null)
  })
})
