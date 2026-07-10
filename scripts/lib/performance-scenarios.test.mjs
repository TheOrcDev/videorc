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
