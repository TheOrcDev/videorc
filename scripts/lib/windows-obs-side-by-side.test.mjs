import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  WINDOWS_OBS_D3D11_HARDWARE_CLASSES,
  WINDOWS_OBS_REQUIRED_ORDER,
  WINDOWS_OBS_SCENARIO,
  WINDOWS_OBS_SETTINGS,
  WINDOWS_OBS_TIMING,
  buildWindowsObsPortableProfile,
  buildWindowsObsRunPlan,
  deriveWindowsD3d11PerformanceBudget,
  evaluateWindowsObsComparison,
  evaluateWindowsObsEndpointMapping,
  extractWindowsAudioEndpointId,
  mergeWindowsObsRunEvidence,
  normalizedWindowsObsSettings,
  parseWindowsObsOrder,
  parseWindowsObsSideBySideArgs,
  summarizeWindowsObsProcessTelemetry,
  windowsObsSettingsIdentity
} from './windows-obs-side-by-side.mjs'
import { buildWindowsStreamPerformanceMatrix } from './windows-stream-performance.mjs'

const SHA = Object.freeze({
  candidate: 'a'.repeat(64),
  payload: 'b'.repeat(64),
  installer: 'c'.repeat(64),
  obs: 'd'.repeat(64),
  settings: 'e'.repeat(64),
  stimulus: 'f'.repeat(64),
  manifest: '1'.repeat(64)
})
const COMMIT = '2'.repeat(40)
const ENDPOINT = '0.0.1.00000000.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const DISPLAY = Object.freeze({
  deviceName: '\\\\.\\DISPLAY1',
  adapterLuid: '00000000000003f1',
  outputIndex: 0,
  desktopBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  refreshHz: 60
})
const RTMP_TARGET = Object.freeze({
  serverUrl: 'rtmp://127.0.0.1:19350/live',
  streamKeySha256: '0'.repeat(64),
  bindingSha256: createHash('sha256')
    .update(
      JSON.stringify({
        serverUrl: 'rtmp://127.0.0.1:19350/live',
        streamKeySha256: '0'.repeat(64)
      })
    )
    .digest('hex')
})

describe('Windows OBS side-by-side protected arguments', () => {
  it('accepts only the exact six-trial order and three trials per app', () => {
    assert.deepEqual(
      parseWindowsObsOrder('obs,videorc,videorc,obs,obs,videorc'),
      WINDOWS_OBS_REQUIRED_ORDER
    )
    assert.throws(
      () => parseWindowsObsOrder('videorc,obs,videorc,obs,videorc,obs'),
      /OBS comparison order/
    )
    const parsed = parseWindowsObsSideBySideArgs([
      '--calibrate',
      '--scenario',
      WINDOWS_OBS_SCENARIO,
      '--runs',
      '3',
      '--order',
      WINDOWS_OBS_REQUIRED_ORDER.join(','),
      '--d3d11',
      '--require-d3d11'
    ])
    assert.equal(parsed.mode, 'calibrate')
    assert.equal(parsed.d3d11, true)
    assert.equal(parsed.requireD3d11, true)
    assert.throws(
      () => parseWindowsObsSideBySideArgs(['--calibrate', '--runs', '2']),
      /exactly --runs 3/
    )
    assert.throws(
      () => parseWindowsObsSideBySideArgs(['--calibrate', '--require-d3d11']),
      /requires the explicit --d3d11/
    )
  })

  it('requires exactly two absolute comparison files and calibration roots', () => {
    const parsed = parseWindowsObsSideBySideArgs([
      '--derive-d3d11-budget',
      '--comparisons',
      '/evidence/nvidia.json,/evidence/intel.json',
      '--stream-calibrations',
      '/evidence/nvidia,/evidence/intel',
      '--profiles',
      '1080p30,1080p60',
      '--output',
      '/evidence/budget.json'
    ])
    assert.equal(parsed.comparisons.length, 2)
    assert.equal(parsed.streamCalibrations.length, 2)
    assert.throws(
      () =>
        parseWindowsObsSideBySideArgs([
          '--derive-d3d11-budget',
          '--comparisons',
          '/evidence/*.json,/evidence/intel.json',
          '--stream-calibrations',
          '/evidence/nvidia,/evidence/intel',
          '--output',
          '/evidence/budget.json'
        ]),
      /aliases or glob/
    )
    assert.throws(
      () =>
        parseWindowsObsSideBySideArgs([
          '--derive-d3d11-budget',
          '--comparisons',
          'nvidia.json,intel.json',
          '--stream-calibrations',
          '/evidence/nvidia,/evidence/intel',
          '--output',
          '/evidence/budget.json'
        ]),
      /must be absolute/
    )
  })

  it('builds one immutable candidate-rooted six-run plan', () => {
    const plan = buildWindowsObsRunPlan({
      evidenceDirectory: '/evidence/nvidia',
      candidateSha256: SHA.candidate
    })
    assert.equal(plan.root, `/evidence/nvidia/windows-stream-obs/${SHA.candidate}`)
    assert.deepEqual(
      plan.runs.map(({ app }) => app),
      WINDOWS_OBS_REQUIRED_ORDER
    )
    assert.match(plan.runs[0].reportPath, /runs\/1-obs\/report\.json$/)
    assert.match(plan.runs[5].reportPath, /runs\/6-videorc\/report\.json$/)
    assert.throws(
      () =>
        buildWindowsObsRunPlan({
          evidenceDirectory: 'relative',
          candidateSha256: SHA.candidate
        }),
      /absolute/
    )
  })
})

describe('Windows OBS normalized inputs', () => {
  it('separates the RTMP secret from retained portable-profile evidence', () => {
    const profile = buildWindowsObsPortableProfile({
      monitorId: DISPLAY.deviceName,
      audioDeviceId: `{0.0.1.00000000}.{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}`,
      serverUrl: 'rtmp://127.0.0.1:1935/live',
      streamKey: 'do-not-retain',
      obsEncoderId: 'obs_nvenc_h264_tex'
    })
    assert.equal(profile.safeFiles.length, 3)
    assert.equal(profile.secretFiles.length, 1)
    assert.ok(profile.secretFiles[0].contents.includes('do-not-retain'))
    assert.ok(profile.safeFiles.every((file) => !file.contents.includes('do-not-retain')))
    assert.match(profile.normalizedSha256, /^[0-9a-f]{64}$/)
    assert.ok(profile.safeFiles.some((file) => file.relativePath.endsWith('streamEncoder.json')))
  })

  it('hashes the same display/audio/video/output/D3D settings deterministically', () => {
    const input = normalizedWindowsObsSettings({
      display: DISPLAY,
      audio: { endpointId: ENDPOINT, friendlyName: 'Mic' },
      obsEncoderId: 'obs_nvenc_h264_tex',
      d3d11: true,
      requireD3d11: true
    })
    const first = windowsObsSettingsIdentity(input)
    const second = windowsObsSettingsIdentity(structuredClone(input))
    assert.equal(first.sha256, second.sha256)
    assert.equal(first.normalized.video.bitrateKbps, 12_000)
    assert.equal(first.normalized.output.keyframeIntervalSeconds, 2)
    assert.equal(first.normalized.presentation.previewOpen, false)
    assert.deepEqual(first.normalized.timing, WINDOWS_OBS_TIMING)
  })

  it('joins Videorc and OBS by canonical display and Core Audio endpoint', () => {
    assert.equal(
      extractWindowsAudioEndpointId(
        '@device_pnp_\\\\?\\SWD#MMDEVAPI#{0.0.1.00000000}.{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}'
      ),
      ENDPOINT
    )
    const pass = evaluateWindowsObsEndpointMapping({
      videorc: {
        display: DISPLAY,
        audio: { endpointId: ENDPOINT, friendlyName: 'Videorc mic' }
      },
      obs: {
        display: { ...DISPLAY, deviceName: '\\\\.\\display1' },
        audio: { endpointId: ENDPOINT, friendlyName: 'OBS mic' }
      }
    })
    assert.equal(pass.verdict, 'PASS')
    assert.equal(pass.display.matched, true)
    assert.equal(pass.audio.matched, true)

    const mismatch = evaluateWindowsObsEndpointMapping({
      videorc: { display: DISPLAY, audio: { endpointId: ENDPOINT } },
      obs: {
        display: { ...DISPLAY, outputIndex: 1 },
        audio: { endpointId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
      }
    })
    assert.equal(mismatch.verdict, 'BLOCKED')
    assert.match(mismatch.blockers.join('\n'), /outputIndex/)
    assert.match(mismatch.blockers.join('\n'), /Core Audio endpoint/)
  })

  it('summarizes complete total and per-role CPU/RSS telemetry', () => {
    const summary = summarizeWindowsObsProcessTelemetry({
      timing: { intervalMs: 1_000 },
      memory: {
        samples: [
          {
            totalRssKb: 102_400,
            byRole: { backend: { rssKb: 61_440 }, 'electron-main': { rssKb: 40_960 } }
          },
          {
            totalRssKb: 104_448,
            byRole: { backend: { rssKb: 62_464 }, 'electron-main': { rssKb: 41_984 } }
          }
        ]
      },
      cpu: {
        samples: [
          { byRole: { backend: 10, 'electron-main': 5 } },
          { byRole: { backend: 12, 'electron-main': 7 } }
        ]
      }
    })
    assert.equal(summary.rssMaxMiB, 102)
    assert.equal(summary.cpuP95Percent, 19)
    assert.equal(summary.roles.backend.rssMaxMiB, 61)
    assert.equal(summary.roles.backend.cpuAveragePercent, 11)
  })
})

describe('Windows OBS evidence admission and merge', () => {
  it('accepts six signed, mapped, clocked, hashed, zero-copy trials', () => {
    const comparison = passingComparison('nvidia-turing-floor')
    const result = evaluateWindowsObsComparison(comparison)
    assert.equal(result.verdict, 'PASS', [...result.failures, ...result.blockers].join('\n'))
    assert.equal(result.medians.obs.cpuP95Percent, 40)
    assert.equal(result.medians.videorc.cpuP95Percent, 44)
  })

  it('blocks incomplete identity/mapping/telemetry without manufacturing a result', () => {
    const comparison = passingComparison('nvidia-turing-floor')
    comparison.candidate.signed = false
    comparison.mapping.verdict = 'BLOCKED'
    comparison.display.matched = false
    comparison.runs[1].gpu.verdict = 'BLOCKED'
    comparison.runs[2].receiver.target = {
      ...RTMP_TARGET,
      serverUrl: 'rtmp://127.0.0.1:19351/live'
    }
    const result = evaluateWindowsObsComparison(comparison)
    assert.equal(result.verdict, 'BLOCKED')
    assert.match(result.blockers.join('\n'), /Authenticode/)
    assert.match(result.blockers.join('\n'), /mapping/)
    assert.match(result.blockers.join('\n'), /GPU evidence/)
    assert.match(result.blockers.join('\n'), /manifest-locked local RTMP target/)
  })

  it('fails resource, media, order, and D3D zero-copy regressions', () => {
    const comparison = passingComparison('nvidia-turing-floor')
    for (const run of comparison.runs.filter(({ app }) => app === 'videorc')) {
      run.process.cpuP95Percent = 60
    }
    comparison.runs[1].media.freezeVerdict = 'FAIL'
    comparison.runs[1].pipeline.zeroCopyVerdict = 'FAIL'
    const result = evaluateWindowsObsComparison(comparison)
    assert.equal(result.verdict, 'FAIL')
    assert.match(result.failures.join('\n'), /CPU p95/)
    assert.match(result.failures.join('\n'), /freeze\/repeat/)
    assert.match(result.failures.join('\n'), /zero-copy/)

    const reordered = passingComparison('nvidia-turing-floor')
    ;[reordered.runs[0], reordered.runs[1]] = [reordered.runs[1], reordered.runs[0]]
    assert.equal(evaluateWindowsObsComparison(reordered).verdict, 'FAIL')
  })

  it('merges only the manifest-locked order and preserves evidence hashes', () => {
    const comparison = passingComparison('nvidia-turing-floor')
    const manifest = {
      scenario: comparison.scenario,
      timing: comparison.timing,
      candidate: comparison.candidate,
      obs: comparison.obs,
      hardware: comparison.hardware,
      mapping: comparison.mapping,
      settings: comparison.settings,
      stimulus: { manifestSha256: SHA.stimulus },
      receiver: comparison.receiver,
      manifestPath: comparison.manifestPath,
      manifestSha256: comparison.manifestSha256
    }
    const merged = mergeWindowsObsRunEvidence({
      manifest,
      runs: comparison.runs
    })
    assert.equal(merged.verdict, 'PASS')
    assert.equal(merged.status, 'CALIBRATION')
    assert.equal(merged.manifestSha256, SHA.manifest)
    assert.throws(
      () =>
        mergeWindowsObsRunEvidence({
          manifest,
          runs: [...comparison.runs].reverse()
        }),
      /protected alternating order/
    )
  })
})

describe('Windows D3D11 OBS-relative draft derivation', () => {
  it('derives the exact NVIDIA/Intel protected 1080p30/60 draft matrix', () => {
    const comparisons = WINDOWS_OBS_D3D11_HARDWARE_CLASSES.map((hardwareClass) =>
      passingComparison(hardwareClass)
    )
    const calibrations = WINDOWS_OBS_D3D11_HARDWARE_CLASSES.flatMap(d3dCalibrations)
    const budget = deriveWindowsD3d11PerformanceBudget({
      comparisons,
      calibrations
    })
    assert.equal(budget.status, 'draft')
    assert.equal(budget.activation.allowed, false)
    assert.equal(
      budget.profiles.length,
      WINDOWS_OBS_D3D11_HARDWARE_CLASSES.length * buildWindowsStreamPerformanceMatrix().length
    )
    assert.deepEqual(budget.qualifiedProfiles, {
      'nvidia-turing-floor': ['1080p30', '1080p60'],
      'intel-xe-integrated': ['1080p30', '1080p60']
    })
    assert.deepEqual(budget.unqualifiedLivestreamProfiles, ['1440p30', '1440p60', '4k30', '4k60'])
    assert.ok(
      budget.profiles.every(
        (profile) =>
          profile.invariants.mediaPath === 'd3d11-native' &&
          profile.thresholds.bmp.maximumRequests === 0 &&
          profile.thresholds.bmp.maximumBytes === 0
      )
    )
    assert.equal(
      budget.profiles.find(({ scope }) => scope.scenario === '1080p60-av-endurance').evidence
        .reportPaths.length,
      1
    )
  })

  it('rejects duplicate/missing classes and mixed candidate identity', () => {
    const nvidia = passingComparison('nvidia-turing-floor')
    const intel = passingComparison('intel-xe-integrated')
    const calibrations = WINDOWS_OBS_D3D11_HARDWARE_CLASSES.flatMap(d3dCalibrations)
    assert.throws(
      () =>
        deriveWindowsD3d11PerformanceBudget({
          comparisons: [nvidia, structuredClone(nvidia)],
          calibrations
        }),
      /Duplicate D3D11 comparison hardware class/
    )
    intel.candidate.sourceCommit = '3'.repeat(40)
    for (const run of intel.runs.filter(({ app }) => app === 'videorc')) {
      run.candidate.sourceCommit = intel.candidate.sourceCommit
    }
    assert.throws(
      () =>
        deriveWindowsD3d11PerformanceBudget({
          comparisons: [nvidia, intel],
          calibrations
        }),
      /candidate\/source\/installer\/payload identity differed/
    )
  })

  it('rejects positive BMP work, missing zero-copy proof, and unqualified profiles', () => {
    const comparisons = WINDOWS_OBS_D3D11_HARDWARE_CLASSES.map((hardwareClass) =>
      passingComparison(hardwareClass)
    )
    const calibrations = WINDOWS_OBS_D3D11_HARDWARE_CLASSES.flatMap(d3dCalibrations)
    const bmp = structuredClone(calibrations)
    bmp[0].runs[0].bmp.requests = 1
    assert.throws(
      () => deriveWindowsD3d11PerformanceBudget({ comparisons, calibrations: bmp }),
      /forbidden BMP work/
    )
    const copied = structuredClone(calibrations)
    copied[0].runs[0].pipeline.zeroCopyVerdict = 'FAIL'
    assert.throws(
      () => deriveWindowsD3d11PerformanceBudget({ comparisons, calibrations: copied }),
      /zero-copy D3D11/
    )
    const profile = structuredClone(calibrations)
    profile[0].scope.profile = '1440p30'
    assert.throws(
      () => deriveWindowsD3d11PerformanceBudget({ comparisons, calibrations: profile }),
      /unqualified profile/
    )
    assert.throws(
      () =>
        deriveWindowsD3d11PerformanceBudget({
          comparisons,
          calibrations: calibrations.slice(1)
        }),
      /exact protected \d+-scenario matrix/
    )
  })
})

describe('Windows OBS runner host boundary', () => {
  it('lists the protected contract without launching on any host', () => {
    const result = spawnSync(process.execPath, [runnerPath(), '--list'], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /obs,videorc,videorc,obs,obs,videorc/)
    assert.match(result.stdout, /local RTMP only/)
  })

  it(
    'reports unsupported/blocked instead of fake calibration success off Windows',
    { skip: process.platform === 'win32' && process.arch === 'x64' },
    () => {
      const result = spawnSync(
        process.execPath,
        [
          runnerPath(),
          '--calibrate',
          '--scenario',
          WINDOWS_OBS_SCENARIO,
          '--runs',
          '3',
          '--order',
          WINDOWS_OBS_REQUIRED_ORDER.join(','),
          '--d3d11',
          '--require-d3d11'
        ],
        { encoding: 'utf8' }
      )
      assert.equal(result.status, 2)
      assert.match(result.stderr, /UNSUPPORTED\/BLOCKED/)
      assert.doesNotMatch(result.stdout, /\bPASS\b/)
    }
  )
})

function passingComparison(hardwareClass) {
  const runs = WINDOWS_OBS_REQUIRED_ORDER.map((app, index) =>
    passingRun({
      app,
      index: index + 1,
      hardwareClass,
      cpuP95Percent: app === 'obs' ? 40 : 44,
      rssP95MiB: app === 'obs' ? 500 : 590,
      rssMaxMiB: app === 'obs' ? 550 : 640,
      gpuEngineP95Percent: app === 'obs' ? 50 : 54,
      gpuDedicatedMaxMiB: app === 'obs' ? 400 : 440,
      gpuSharedMaxMiB: app === 'obs' ? 100 : 108
    })
  )
  return {
    schemaVersion: 1,
    kind: 'videorc.windows-obs-side-by-side',
    status: 'CALIBRATION',
    scenario: WINDOWS_OBS_SCENARIO,
    timing: { ...WINDOWS_OBS_TIMING },
    candidate: candidateIdentity(),
    obs: obsIdentity(),
    hardware: {
      hardwareClass,
      bootId: `${hardwareClass}-boot`,
      fingerprint: hardwareClass === 'nvidia-turing-floor' ? '8'.repeat(64) : '9'.repeat(64)
    },
    mapping: {
      verdict: 'PASS',
      blockers: [],
      display: { matched: true, videorc: DISPLAY, obs: DISPLAY },
      audio: {
        matched: true,
        videorc: { endpointId: ENDPOINT },
        obs: { endpointId: ENDPOINT }
      }
    },
    display: { matched: true, videorc: DISPLAY, obs: DISPLAY },
    audio: {
      matched: true,
      videorc: { endpointId: ENDPOINT },
      obs: { endpointId: ENDPOINT }
    },
    settings: {
      sha256: SHA.settings,
      normalized: {
        scenario: WINDOWS_OBS_SCENARIO,
        video: { ...WINDOWS_OBS_SETTINGS },
        d3d11: { selected: true, required: true }
      }
    },
    stimulus: { manifestSha256: SHA.stimulus },
    receiver: {
      protocol: 'rtmp-listen-flv-copy',
      ffmpegPath: '/tools/ffmpeg',
      ffmpegSha256: '5'.repeat(64),
      ffprobePath: '/tools/ffprobe',
      ffprobeSha256: '6'.repeat(64),
      target: RTMP_TARGET
    },
    manifestPath: `/evidence/${hardwareClass}/manifest.json`,
    manifestSha256: SHA.manifest,
    aggregatePath: `/evidence/${hardwareClass}/aggregate.json`,
    aggregateSha256: hardwareClass === 'nvidia-turing-floor' ? '3'.repeat(64) : '4'.repeat(64),
    runs
  }
}

function passingRun({
  app,
  index,
  hardwareClass,
  cpuP95Percent,
  rssP95MiB,
  rssMaxMiB,
  gpuEngineP95Percent,
  gpuDedicatedMaxMiB,
  gpuSharedMaxMiB
}) {
  return {
    schemaVersion: 1,
    kind: 'videorc.windows-obs-side-by-side-run',
    index,
    app,
    scenario: WINDOWS_OBS_SCENARIO,
    clean: true,
    timing: { ...WINDOWS_OBS_TIMING },
    bootId: `${hardwareClass}-boot`,
    hardwareClass,
    settingsSha256: SHA.settings,
    candidateSha256: app === 'videorc' ? SHA.candidate : undefined,
    candidate: app === 'videorc' ? candidateIdentity() : undefined,
    obs: app === 'obs' ? obsIdentity() : undefined,
    stimulus: {
      verdict: 'PASS',
      manifestSha256: SHA.stimulus,
      teardownClean: true
    },
    media: {
      verdict: 'PASS',
      freezeVerdict: 'PASS',
      repeatVerdict: 'PASS'
    },
    pipeline:
      app === 'videorc'
        ? { verdict: 'PASS', zeroCopyVerdict: 'PASS' }
        : { verdict: 'PASS', zeroCopyVerdict: 'NOT_APPLICABLE' },
    receiver: { verdict: 'PASS', target: RTMP_TARGET },
    process: {
      telemetryVerdict: 'PASS',
      teardownClean: true,
      forced: false,
      rootIdentity: {
        pid: 10_000 + index,
        creationDate: `20260730090${index}00.000000+000`,
        executablePath:
          app === 'videorc'
            ? 'C:\\Program Files\\Videorc\\Videorc.exe'
            : 'C:\\Temp\\obs-studio\\bin\\64bit\\obs64.exe'
      },
      cpuP95Percent,
      rssP95MiB,
      rssMaxMiB,
      rssSlopeMiBPerMinute: 1,
      roles: {
        backend: {
          rssMaxMiB: 230,
          rssSlopeMiBPerMinute: 1,
          cpuAveragePercent: 18,
          cpuP95Percent: 28
        }
      }
    },
    gpu: {
      verdict: 'PASS',
      summary: {
        engineBusyP95Percent: gpuEngineP95Percent,
        dedicatedMaxMiB: gpuDedicatedMaxMiB,
        sharedMaxMiB: gpuSharedMaxMiB
      }
    },
    artifacts: [
      {
        path: `/evidence/${hardwareClass}/runs/${index}-${app}/receiver.flv`,
        sha256: '9'.repeat(64)
      }
    ],
    reportPath: `/evidence/${hardwareClass}/runs/${index}-${app}/report.json`,
    reportSha256: String(index).repeat(64)
  }
}

function candidateIdentity() {
  return {
    executablePath: 'C:\\Program Files\\Videorc\\Videorc.exe',
    sha256: SHA.candidate,
    packagePayload: {
      sha256: SHA.payload,
      components: [
        { relativePath: 'resources/app.asar', sha256: '5'.repeat(64) },
        { relativePath: 'resources/videorc-backend.exe', sha256: '6'.repeat(64) }
      ]
    },
    sourceCommit: COMMIT,
    installerSha256: SHA.installer,
    signed: true,
    signature: { status: 'Valid' }
  }
}

function obsIdentity() {
  return {
    executablePath: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
    sha256: SHA.obs,
    portableExecutablePath: 'C:\\Temp\\obs-studio\\bin\\64bit\\obs64.exe',
    portableSha256: SHA.obs,
    version: '31.1.2',
    signed: true,
    signature: { status: 'Valid' }
  }
}

function d3dCalibrations(hardwareClass) {
  return buildWindowsStreamPerformanceMatrix().map((scenario) =>
    d3dCalibration(hardwareClass, scenario)
  )
}

function d3dCalibration(hardwareClass, scenario) {
  const profile = scenario.fps === 60 ? '1080p60' : '1080p30'
  const previewOpen = scenario.previewOpen
  const id = `${hardwareClass}-${scenario.id}`
  return {
    schemaVersion: 1,
    kind: 'videorc.windows-d3d11-stream-calibration',
    id,
    candidate: candidateIdentity(),
    scope: {
      scenario: scenario.id,
      profile,
      hardwareClass,
      profileClass: 'release',
      buildMode: 'packaged',
      operatingSystem: { platform: 'win32', arch: 'x64', release: '10.0.26100' },
      timing: {
        warmupMs: scenario.warmupMs,
        measurementMs: scenario.measurementMs,
        intervalMs: scenario.sampleIntervalMs
      },
      mediaPath: 'd3d11-native',
      topology: scenario.topology,
      sourceComposition: scenario.sourceComposition,
      previewOpen,
      ...(previewOpen
        ? {
            preview: {
              transport: 'd3d11-shared-texture',
              backing: 'directcomposition-swapchain',
              hostKind: 'backend-d3d11-presenter'
            }
          }
        : {})
    },
    aggregatePath: `/evidence/${hardwareClass}/stream/${id}/aggregate.json`,
    aggregateSha256: '7'.repeat(64),
    runs: Array.from({ length: scenario.repetitions }, (_, index) => ({
      verdict: 'PASS',
      pipeline: { zeroCopyVerdict: 'PASS' },
      bmp: { mode: 'disabled', requests: 0, bytes: 0 },
      reportPath: `/evidence/${hardwareClass}/stream/${id}/run-${index + 1}.json`,
      reportSha256: `${index + 6}`.repeat(64),
      process: {
        rssMaxMiB: 610 + index,
        roles: Object.fromEntries(
          ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg'].map(
            (role, roleIndex) => [
              role,
              {
                rssMaxMiB: 100 + roleIndex * 10 + index,
                rssSlopeMiBPerMinute: 1,
                cpuAveragePercent: 8 + roleIndex + index,
                cpuP95Percent: 12 + roleIndex + index
              }
            ]
          )
        )
      }
    }))
  }
}

function runnerPath() {
  return resolve('scripts/smoke-windows-obs-side-by-side.mjs')
}
