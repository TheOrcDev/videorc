import { join, resolve } from 'node:path'

export const PERFORMANCE_SCENARIOS = [
  'ui-idle',
  'docked-native-preview',
  'detached-native-preview',
  'preview-lifecycle',
  'jpeg-fallback',
  'real-devices-1080p',
  'record-4k',
  'record-4k-stream-1080p'
]

export const MACOS_PERFORMANCE_POWER_ASSERTION = 'caffeinate:-d,-i,-s'

/**
 * Keep wall-clock endurance evidence comparable on macOS. A sleeping display
 * can suspend ScreenCaptureKit/CAMetalLayer and a clamshell host can then enter
 * system sleep while Date.now() continues to advance. Wrap the complete
 * scenario (not just the app child) so warm-up, measurement, and teardown are
 * covered by the same explicit assertion and recorded in child provenance.
 */
export function performanceScenarioLaunchSpec(
  scenario,
  { platform = process.platform, caffeinatePath = '/usr/bin/caffeinate' } = {}
) {
  if (platform !== 'darwin') {
    return {
      ...scenario,
      env: { ...scenario.env, VIDEORC_PERF_POWER_ASSERTION: '' },
      powerAssertion: null
    }
  }

  const flags = ['-d', '-i', '-s']
  return {
    ...scenario,
    command: caffeinatePath,
    args: [...flags, scenario.command, ...scenario.args],
    env: {
      ...scenario.env,
      VIDEORC_PERF_POWER_ASSERTION: MACOS_PERFORMANCE_POWER_ASSERTION
    },
    powerAssertion: { provider: 'caffeinate', flags }
  }
}

export function buildPerformanceScenario({
  scenario,
  mode,
  warmupSeconds = 60,
  measurementSeconds = 600,
  childReportPath,
  runNonce,
  expectedBuildMode,
  node = process.execPath
}) {
  if (!PERFORMANCE_SCENARIOS.includes(scenario)) {
    throw new Error(
      `Unknown performance scenario ${scenario}. Choose: ${PERFORMANCE_SCENARIOS.join(', ')}.`
    )
  }
  if (!['gate', 'report-only'].includes(mode)) {
    throw new Error(`Unknown performance mode ${mode}.`)
  }
  const modeArg = mode === 'gate' ? '--gate' : '--report-only'
  const commonEnv = {
    VIDEORC_PERF_MODE: mode,
    VIDEORC_PERF_REPORT_PATH: childReportPath,
    VIDEORC_PERF_SCENARIO: scenario,
    VIDEORC_PERF_RUN_NONCE: runNonce,
    VIDEORC_PERF_EXPECT_BUILD_MODE: expectedBuildMode,
    ...scenarioMetadataEnvironment(scenario)
  }

  if (scenario === 'ui-idle') {
    return {
      command: node,
      args: ['scripts/smoke-process-memory.mjs', modeArg],
      env: {
        ...commonEnv,
        VIDEORC_PROCESS_MEMORY_WARMUP_MS: String(warmupSeconds * 1000),
        VIDEORC_PROCESS_MEMORY_SAMPLE_MS: String(measurementSeconds * 1000)
      },
      deviceRequired: false
    }
  }

  if (scenario === 'docked-native-preview' || scenario === 'detached-native-preview') {
    return {
      command: node,
      args: ['scripts/perf-idle-probe.mjs', modeArg],
      env: {
        ...commonEnv,
        VIDEORC_PERF_WARMUP_SECONDS: String(warmupSeconds),
        VIDEORC_PERF_SAMPLE_SECONDS: String(measurementSeconds),
        VIDEORC_PERF_PREVIEW_MODE: scenario === 'docked-native-preview' ? 'docked' : 'detached'
      },
      deviceRequired: false
    }
  }

  if (scenario === 'preview-lifecycle') {
    const cycles = process.env.VIDEORC_PREVIEW_LIFECYCLE_CYCLES ?? '100'
    return {
      command: node,
      args: ['scripts/preview-lifecycle-probe.mjs'],
      env: {
        ...commonEnv,
        VIDEORC_PREVIEW_LIFECYCLE_CYCLES: cycles
      },
      timing: { cycles: Number(cycles) },
      deviceRequired: false
    }
  }

  if (scenario === 'jpeg-fallback') {
    return {
      command: node,
      args: ['scripts/smoke-preview-performance-app.mjs', modeArg],
      env: {
        ...commonEnv,
        VIDEORC_PREVIEW_WARMUP_MS: String(warmupSeconds * 1000),
        VIDEORC_PREVIEW_SAMPLE_MS: String(measurementSeconds * 1000),
        VIDEORC_PREVIEW_EXPECT_TRANSPORT: 'latest-jpeg-polling',
        VIDEORC_PREVIEW_EXPECT_BACKING: 'none'
      },
      deviceRequired: false
    }
  }

  if (scenario === 'real-devices-1080p') {
    return {
      command: 'pnpm',
      args: ['baseline:real-source', modeArg],
      env: {
        ...commonEnv,
        VIDEORC_BASELINE_WIDTH: '1920',
        VIDEORC_BASELINE_HEIGHT: '1080',
        VIDEORC_BASELINE_FPS: '30',
        VIDEORC_BASELINE_BITRATE_KBPS: '6000',
        VIDEORC_BASELINE_SCREEN_MOTION_STIMULUS: '1',
        VIDEORC_BASELINE_NO_PREVIEW_SURFACE: '0',
        VIDEORC_PERF_EXPECT_TRANSPORT: 'native-surface',
        VIDEORC_PERF_EXPECT_BACKING: 'cametal-layer',
        VIDEORC_BASELINE_WARMUP_MS: String(warmupSeconds * 1000),
        VIDEORC_BASELINE_RECORDING_MS: String((warmupSeconds + measurementSeconds) * 1000),
        VIDEORC_SMOKE_TIMEOUT_MS: String((warmupSeconds + measurementSeconds + 300) * 1000)
      },
      deviceRequired: true
    }
  }

  if (scenario === 'record-4k') {
    return {
      command: 'pnpm',
      args: ['baseline:real-source:4k30', ...(mode === 'gate' ? ['--gate'] : [])],
      env: {
        ...commonEnv,
        VIDEORC_BASELINE_NO_PREVIEW_SURFACE: '0',
        VIDEORC_PERF_EXPECT_TRANSPORT: 'native-surface',
        VIDEORC_PERF_EXPECT_BACKING: 'cametal-layer',
        VIDEORC_BASELINE_WARMUP_MS: String(warmupSeconds * 1000),
        VIDEORC_BASELINE_RECORDING_MS: String((warmupSeconds + measurementSeconds) * 1000),
        VIDEORC_SMOKE_TIMEOUT_MS: String((warmupSeconds + measurementSeconds + 300) * 1000)
      },
      deviceRequired: true
    }
  }

  return {
    command: 'pnpm',
    args: ['baseline:stream:split-output-4k-record:base', modeArg],
    env: {
      ...commonEnv,
      VIDEORC_BASELINE_NO_PREVIEW_SURFACE: '0',
      VIDEORC_PERF_EXPECT_TRANSPORT: 'native-surface',
      VIDEORC_PERF_EXPECT_BACKING: 'cametal-layer',
      VIDEORC_BASELINE_WARMUP_MS: String(warmupSeconds * 1000),
      VIDEORC_BASELINE_RECORDING_MS: String((warmupSeconds + measurementSeconds) * 1000),
      VIDEORC_SMOKE_TIMEOUT_MS: String((warmupSeconds + measurementSeconds + 300) * 1000)
    },
    deviceRequired: true
  }
}

function scenarioMetadataEnvironment(scenario) {
  if (scenario === 'ui-idle') {
    return { VIDEORC_PERF_APP_ROLE: 'ui-idle' }
  }
  if (scenario === 'record-4k') {
    return {
      VIDEORC_PERF_APP_ROLE: 'recording',
      VIDEORC_PERF_SOURCE_WIDTH: '3840',
      VIDEORC_PERF_SOURCE_HEIGHT: '2160',
      VIDEORC_PERF_SOURCE_FPS: '30',
      VIDEORC_PERF_OUTPUTS_JSON: JSON.stringify([
        { role: 'recording', width: 3840, height: 2160, fps: 30 }
      ])
    }
  }
  if (scenario === 'real-devices-1080p') {
    return {
      VIDEORC_PERF_APP_ROLE: 'real-screen-camera-microphone-recording',
      VIDEORC_PERF_SOURCE_WIDTH: '1920',
      VIDEORC_PERF_SOURCE_HEIGHT: '1080',
      VIDEORC_PERF_SOURCE_FPS: '30',
      VIDEORC_PERF_OUTPUTS_JSON: JSON.stringify([
        { role: 'recording', width: 1920, height: 1080, fps: 30 }
      ])
    }
  }
  if (scenario === 'record-4k-stream-1080p') {
    return {
      VIDEORC_PERF_APP_ROLE: 'recording+streaming',
      VIDEORC_PERF_SOURCE_WIDTH: '3840',
      VIDEORC_PERF_SOURCE_HEIGHT: '2160',
      VIDEORC_PERF_SOURCE_FPS: '30',
      VIDEORC_PERF_OUTPUTS_JSON: JSON.stringify([
        { role: 'recording', width: 3840, height: 2160, fps: 30 },
        { role: 'streaming', width: 1920, height: 1080, fps: 30 }
      ])
    }
  }
  return {
    VIDEORC_PERF_APP_ROLE: scenario,
    VIDEORC_PERF_SOURCE_WIDTH: '1280',
    VIDEORC_PERF_SOURCE_HEIGHT: '720',
    VIDEORC_PERF_SOURCE_FPS: '60',
    VIDEORC_PERF_OUTPUTS_JSON: JSON.stringify([
      { role: 'preview', width: 1280, height: 720, fps: 60 }
    ])
  }
}

export function performanceScenarioReportPaths({
  scenario,
  outputPath,
  artifactRoot = 'docs/acceptance/artifacts/performance'
}) {
  const wrapper = resolve(
    outputPath ??
      join(artifactRoot, `${scenario}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  )
  return {
    wrapper,
    child: /\.json$/i.test(wrapper)
      ? wrapper.replace(/\.json$/i, '.child.json')
      : `${wrapper}.child.json`
  }
}
