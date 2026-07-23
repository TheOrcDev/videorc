import { join, resolve } from 'node:path'

export const PERFORMANCE_SCENARIOS = [
  'ui-idle',
  'docked-native-preview',
  'detached-native-preview',
  'preview-lifecycle',
  'jpeg-fallback',
  'real-devices-1080p',
  'record-1080p60',
  'record-vertical-4k30',
  'windows-proof-recording-1080p',
  'windows-proof-recording-4k',
  'windows-occluded-aux-windows',
  'studio-live-mic-visuals',
  'lifecycle-churn',
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
  profileClass,
  appVersion,
  sampleIntervalMs = 1_000,
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
    ...(profileClass ? { VIDEORC_PERF_PROFILE_CLASS: profileClass } : {}),
    ...(appVersion ? { VIDEORC_PERF_APP_VERSION: appVersion } : {}),
    VIDEORC_PERF_WARMUP_MS: String(warmupSeconds * 1_000),
    VIDEORC_PERF_MEASUREMENT_MS: String(measurementSeconds * 1_000),
    VIDEORC_PERF_SAMPLE_INTERVAL_MS: String(sampleIntervalMs),
    ...scenarioMetadataEnvironment(scenario)
  }

  if (scenario === 'ui-idle') {
    return {
      command: node,
      args: ['scripts/smoke-process-memory.mjs', modeArg],
      env: {
        ...commonEnv,
        VIDEORC_PROCESS_MEMORY_WARMUP_MS: String(warmupSeconds * 1000),
        VIDEORC_PROCESS_MEMORY_SAMPLE_MS: String(measurementSeconds * 1000),
        VIDEORC_PROCESS_MEMORY_INTERVAL_MS: String(sampleIntervalMs)
      },
      deviceRequired: false
    }
  }

  if (scenario === 'windows-proof-recording-1080p' || scenario === 'windows-proof-recording-4k') {
    const fourK = scenario === 'windows-proof-recording-4k'
    const width = fourK ? 3840 : 1920
    const height = fourK ? 2160 : 1080
    const fps = 30
    return {
      command: node,
      args: ['scripts/smoke-windows-native-screen-app.mjs'],
      env: {
        ...commonEnv,
        VIDEORC_WINDOWS_NATIVE_SCREEN_RECORDING_MS: String(
          (warmupSeconds + measurementSeconds) * 1_000
        ),
        VIDEORC_SMOKE_TIMEOUT_MS: String((warmupSeconds + measurementSeconds + 300) * 1_000),
        VIDEORC_SMOKE_VIDEO_WIDTH: String(width),
        VIDEORC_SMOKE_VIDEO_HEIGHT: String(height),
        VIDEORC_SMOKE_VIDEO_FPS: String(fps),
        VIDEORC_SMOKE_VIDEO_BITRATE_KBPS: fourK ? '30000' : '6000'
      },
      deviceRequired: true
    }
  }

  if (
    scenario === 'windows-proof-recording-1080p' ||
    scenario === 'windows-proof-recording-4k' ||
    scenario === 'windows-occluded-aux-windows'
  ) {
    const fourK = scenario === 'windows-proof-recording-4k'
    const width = fourK ? 3840 : 1920
    const height = fourK ? 2160 : 1080
    const fps = 30
    return {
      command: node,
      args: ['scripts/smoke-windows-native-screen-app.mjs'],
      env: {
        ...commonEnv,
        VIDEORC_WINDOWS_NATIVE_SCREEN_RECORDING_MS: String(
          (warmupSeconds + measurementSeconds) * 1_000
        ),
        VIDEORC_SMOKE_TIMEOUT_MS: String((warmupSeconds + measurementSeconds + 300) * 1_000),
        VIDEORC_SMOKE_VIDEO_WIDTH: String(width),
        VIDEORC_SMOKE_VIDEO_HEIGHT: String(height),
        VIDEORC_SMOKE_VIDEO_FPS: String(fps),
        VIDEORC_SMOKE_VIDEO_BITRATE_KBPS: fourK ? '30000' : '6000',
        ...(scenario === 'windows-occluded-aux-windows'
          ? { VIDEORC_PERF_OCCLUDED_AUX_WINDOWS: '1' }
          : {})
      },
      deviceRequired: true
    }
  }

  if (
    scenario === 'docked-native-preview' ||
    scenario === 'detached-native-preview' ||
    scenario === 'studio-live-mic-visuals'
  ) {
    const micVisuals = scenario === 'studio-live-mic-visuals'
    return {
      command: node,
      args: ['scripts/perf-idle-probe.mjs', modeArg],
      env: {
        ...commonEnv,
        VIDEORC_PERF_WARMUP_SECONDS: String(warmupSeconds),
        VIDEORC_PERF_SAMPLE_SECONDS: String(measurementSeconds),
        VIDEORC_PERF_PREVIEW_MODE:
          scenario === 'docked-native-preview' || micVisuals ? 'docked' : 'detached',
        ...(micVisuals ? { VIDEORC_PERF_REQUIRE_STUDIO_MIC_VISUALS: '1' } : {})
      },
      deviceRequired: micVisuals
    }
  }

  if (scenario === 'preview-lifecycle' || scenario === 'lifecycle-churn') {
    const cycles =
      process.env.VIDEORC_PREVIEW_LIFECYCLE_CYCLES ??
      (scenario === 'lifecycle-churn' ? '200' : '100')
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
        VIDEORC_BASELINE_SAMPLE_MS: String(sampleIntervalMs),
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
        VIDEORC_BASELINE_SAMPLE_MS: String(sampleIntervalMs),
        VIDEORC_BASELINE_RECORDING_MS: String((warmupSeconds + measurementSeconds) * 1000),
        VIDEORC_SMOKE_TIMEOUT_MS: String((warmupSeconds + measurementSeconds + 300) * 1000)
      },
      deviceRequired: true
    }
  }

  if (scenario === 'record-1080p60' || scenario === 'record-vertical-4k30') {
    const vertical = scenario === 'record-vertical-4k30'
    const width = vertical ? 2160 : 1920
    const height = vertical ? 3840 : 1080
    const fps = vertical ? 30 : 60
    return {
      command: 'pnpm',
      args: ['baseline:real-source', modeArg],
      env: {
        ...commonEnv,
        VIDEORC_BASELINE_WIDTH: String(width),
        VIDEORC_BASELINE_HEIGHT: String(height),
        VIDEORC_BASELINE_FPS: String(fps),
        VIDEORC_BASELINE_BITRATE_KBPS: vertical ? '30000' : '12000',
        VIDEORC_BASELINE_SCREEN_MOTION_STIMULUS: '1',
        VIDEORC_BASELINE_NO_PREVIEW_SURFACE: '0',
        VIDEORC_PERF_EXPECT_TRANSPORT: 'native-surface',
        VIDEORC_PERF_EXPECT_BACKING: 'cametal-layer',
        VIDEORC_BASELINE_WARMUP_MS: String(warmupSeconds * 1000),
        VIDEORC_BASELINE_SAMPLE_MS: String(sampleIntervalMs),
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
      VIDEORC_BASELINE_SAMPLE_MS: String(sampleIntervalMs),
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
  if (
    scenario === 'windows-proof-recording-1080p' ||
    scenario === 'windows-proof-recording-4k' ||
    scenario === 'windows-occluded-aux-windows'
  ) {
    const fourK = scenario === 'windows-proof-recording-4k'
    return {
      VIDEORC_PERF_APP_ROLE:
        scenario === 'windows-occluded-aux-windows'
          ? 'windows-occluded-notes-comments-captions-recording'
          : 'windows-proof-surface-recording',
      VIDEORC_PERF_SOURCE_WIDTH: fourK ? '3840' : '1920',
      VIDEORC_PERF_SOURCE_HEIGHT: fourK ? '2160' : '1080',
      VIDEORC_PERF_SOURCE_FPS: '30',
      VIDEORC_PERF_OUTPUTS_JSON: JSON.stringify([
        { role: 'recording', width: fourK ? 3840 : 1920, height: fourK ? 2160 : 1080, fps: 30 }
      ])
    }
  }
  if (scenario === 'record-1080p60') {
    return {
      VIDEORC_PERF_APP_ROLE: 'recording',
      VIDEORC_PERF_SOURCE_WIDTH: '1920',
      VIDEORC_PERF_SOURCE_HEIGHT: '1080',
      VIDEORC_PERF_SOURCE_FPS: '60',
      VIDEORC_PERF_OUTPUTS_JSON: JSON.stringify([
        { role: 'recording', width: 1920, height: 1080, fps: 60 }
      ])
    }
  }
  if (scenario === 'record-vertical-4k30') {
    return {
      VIDEORC_PERF_APP_ROLE: 'vertical-recording',
      VIDEORC_PERF_SOURCE_WIDTH: '2160',
      VIDEORC_PERF_SOURCE_HEIGHT: '3840',
      VIDEORC_PERF_SOURCE_FPS: '30',
      VIDEORC_PERF_OUTPUTS_JSON: JSON.stringify([
        { role: 'recording', width: 2160, height: 3840, fps: 30 }
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
