import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import {
  createPerformanceReport,
  currentMacosCaffeinatePowerAssertionVerified,
  evaluateChildPerformanceRun,
  evaluateChildPerformanceMetadata,
  evaluateExplicitFallbackStatus,
  evaluateScenarioTruth,
  evaluateSeriesGate,
  macosCaffeinatePowerAssertionVerified,
  observationCheck,
  packagedAppPayloadIdentity,
  packagedAppPayloadManifestSha256,
  performanceBuildMode,
  performanceHardwareClass,
  performanceMetadataWithObservedDisplayScale,
  performanceMode,
  performanceWrapperMetadataAfterChild,
  sha256File,
  summarizeNumericSeries
} from './performance-contract.mjs'

describe('macOS caffeinate assertion verification', () => {
  const assertions = `
Listed by owning process:
   pid 900(caffeinate): [0x1] PreventUserIdleSystemSleep named: "caffeinate command-line tool"
\tDetails: caffeinate asserting on behalf of '/usr/local/bin/node' (pid 4242)
   pid 900(caffeinate): [0x2] PreventUserIdleDisplaySleep named: "caffeinate command-line tool"
\tDetails: caffeinate asserting on behalf of '/usr/local/bin/node' (pid 4242)
   pid 900(caffeinate): [0x3] PreventSystemSleep named: "caffeinate command-line tool"
\tDetails: caffeinate asserting on behalf of '/usr/local/bin/node' (pid 4242)
`

  it('requires all three assertions to name the current scenario process', () => {
    assert.equal(macosCaffeinatePowerAssertionVerified(assertions, 4242), true)
    assert.equal(macosCaffeinatePowerAssertionVerified(assertions, 4243), false)
    assert.equal(
      macosCaffeinatePowerAssertionVerified(
        assertions.replace('PreventSystemSleep', 'Other'),
        4242
      ),
      false
    )
  })

  it('never trusts a marker on a non-macOS host', async () => {
    assert.equal(
      await currentMacosCaffeinatePowerAssertionVerified({
        env: { VIDEORC_PERF_POWER_ASSERTION: 'caffeinate:-d,-i,-s' },
        pid: 4242,
        osPlatform: 'linux'
      }),
      false
    )
  })

  it('lets a wrapper claim verification only after its matching child proves it', () => {
    const wrapper = {
      powerAssertion: 'caffeinate:-d,-i,-s',
      powerAssertionVerified: false
    }
    assert.equal(
      performanceWrapperMetadataAfterChild(wrapper, {
        powerAssertion: 'caffeinate:-d,-i,-s',
        powerAssertionVerified: true
      }).powerAssertionVerified,
      true
    )
    assert.equal(
      performanceWrapperMetadataAfterChild(wrapper, {
        powerAssertion: 'wrong',
        powerAssertionVerified: true
      }).powerAssertionVerified,
      false
    )
  })
})

describe('performanceBuildMode', () => {
  it('recognizes both packaged-app launch markers', () => {
    assert.equal(performanceBuildMode({}), 'development')
    assert.equal(performanceBuildMode({ VIDEORC_SMOKE_PACKAGED_APP: '1' }), 'packaged')
    assert.equal(
      performanceBuildMode({ VIDEORC_PERF_APP_EXECUTABLE: '/Applications/Videorc.app/Videorc' }),
      'packaged'
    )
  })
})

describe('performance display scale reconciliation', () => {
  it('uses an observed pipeline scale only when system metadata is absent', () => {
    assert.deepEqual(
      performanceMetadataWithObservedDisplayScale(
        { displayScaleFactor: null, machineModel: 'VirtualMac2,1' },
        1
      ),
      { displayScaleFactor: 1, machineModel: 'VirtualMac2,1' }
    )

    const systemMetadata = { displayScaleFactor: 2 }
    assert.equal(performanceMetadataWithObservedDisplayScale(systemMetadata, 1), systemMetadata)

    const invalidSystemMetadata = { displayScaleFactor: 0 }
    assert.equal(
      performanceMetadataWithObservedDisplayScale(invalidSystemMetadata, 1),
      invalidSystemMetadata
    )
  })

  it('reconciles a headless wrapper scale from its completed child report', () => {
    assert.deepEqual(
      performanceWrapperMetadataAfterChild(
        { displayScaleFactor: null, machineModel: 'VirtualMac2,1' },
        { displayScaleFactor: 1 }
      ),
      { displayScaleFactor: 1, machineModel: 'VirtualMac2,1' }
    )
  })
})

describe('performanceHardwareClass', () => {
  it('records only an explicit non-empty hardware class', () => {
    assert.equal(performanceHardwareClass({}), null)
    assert.equal(performanceHardwareClass({ VIDEORC_PERF_HARDWARE_CLASS: '  ' }), null)
    assert.equal(
      performanceHardwareClass({
        VIDEORC_PERF_HARDWARE_CLASS: ' github-hosted-macos-15-arm64-standard '
      }),
      'github-hosted-macos-15-arm64-standard'
    )
  })
})

describe('performanceMode', () => {
  it('defaults to report-only and accepts an explicit gate', () => {
    assert.equal(performanceMode({ argv: [], env: {} }), 'report-only')
    assert.equal(performanceMode({ argv: ['--gate'], env: {} }), 'gate')
    assert.equal(performanceMode({ argv: [], env: { VIDEORC_PERF_MODE: 'gate' } }), 'gate')
  })

  it('rejects conflicting modes', () => {
    assert.throws(
      () => performanceMode({ argv: ['--gate', '--report-only'], env: {} }),
      /exactly one performance mode/
    )
  })
})

describe('summarizeNumericSeries', () => {
  it('separates warm-up, compares window medians, and reports slopes per minute', () => {
    const summary = summarizeNumericSeries(
      [0, 10, 20, 30, 40, 50, 60].map((value, index) => ({
        atMs: index * 60_000,
        value
      })),
      { warmupMs: 60_000, tailWindowMs: 120_000 }
    )

    assert.equal(summary.samples, 6)
    assert.equal(summary.firstMedian, 20)
    assert.equal(summary.lastMedian, 50)
    assert.equal(summary.plateauGrowth, 30)
    assert.ok(Math.abs(summary.slopePerMinute - 10) < 0.0001)
    assert.ok(Math.abs(summary.secondHalfSlopePerMinute - 10) < 0.0001)
  })

  it('returns a stable empty summary', () => {
    assert.deepEqual(summarizeNumericSeries([]), {
      samples: 0,
      startAtMs: null,
      endAtMs: null,
      durationMs: 0,
      min: null,
      max: null,
      firstMedian: null,
      lastMedian: null,
      plateauGrowth: null,
      slopePerMinute: null,
      secondHalfSlopePerMinute: null
    })
  })
})

describe('evaluateSeriesGate', () => {
  it('fails synthetic positive growth in gate evaluation', () => {
    const failures = evaluateSeriesGate(
      {
        samples: 10,
        max: 400,
        plateauGrowth: 80,
        slopePerMinute: 20,
        secondHalfSlopePerMinute: 22
      },
      {
        label: 'renderer RSS MB',
        minSamples: 8,
        maxValue: 512,
        maxPlateauGrowth: 20,
        maxSlopePerMinute: 5,
        maxSecondHalfSlopePerMinute: 5
      }
    )

    assert.deepEqual(failures, [
      'renderer RSS MB first/last median growth 80 exceeded 20',
      'renderer RSS MB regression slope per minute 20 exceeded 5',
      'renderer RSS MB second-half slope per minute 22 exceeded 5'
    ])
  })
})

describe('evaluateScenarioTruth', () => {
  it('fails zero frames, missing audio, fallback, and dirty teardown independently of budgets', () => {
    assert.deepEqual(
      evaluateScenarioTruth({
        frames: 0,
        audioRequired: true,
        audioStreams: 0,
        expectedTransport: 'native-surface',
        actualTransport: 'latest-jpeg-polling',
        expectedBacking: 'cametal-layer',
        actualBacking: 'jpeg',
        teardownClean: false
      }),
      [
        'frame progress was 0; expected more than zero frames',
        'required audio stream was missing',
        'preview transport was latest-jpeg-polling; expected native-surface',
        'preview backing was jpeg; expected cametal-layer',
        'app-owned process teardown was not clean'
      ]
    )
  })
})

describe('evaluateExplicitFallbackStatus', () => {
  it('requires transport, backing, and an explicit non-empty JPEG fallback message', () => {
    assert.deepEqual(
      evaluateExplicitFallbackStatus({
        expectedTransport: 'latest-jpeg-polling',
        actualTransport: 'native-surface',
        expectedBacking: 'none',
        actualBacking: 'cametal-layer',
        fallbackMessage: 'Live preview is receiving frames.',
        fallbackLabel: 'JPEG'
      }),
      [
        'preview transport was native-surface; expected latest-jpeg-polling',
        'preview backing was cametal-layer; expected none',
        'fallback reason/message did not identify JPEG',
        'fallback reason/message did not explicitly identify a fallback'
      ]
    )
    assert.deepEqual(
      evaluateExplicitFallbackStatus({
        expectedTransport: 'latest-jpeg-polling',
        actualTransport: 'latest-jpeg-polling',
        expectedBacking: 'none',
        actualBacking: 'none',
        fallbackMessage: 'Explicit JPEG polling fallback is active and receiving frames.',
        fallbackLabel: 'JPEG'
      }),
      []
    )
    assert.deepEqual(
      evaluateExplicitFallbackStatus({
        expectedTransport: 'latest-jpeg-polling',
        actualTransport: 'latest-jpeg-polling',
        expectedBacking: 'none',
        actualBacking: 'none',
        fallbackMessage: '   ',
        fallbackLabel: 'JPEG'
      }),
      ['explicit fallback reason/message was missing']
    )
  })
})

describe('evaluateChildPerformanceRun', () => {
  const startedAtMs = Date.parse('2026-07-10T12:00:00.000Z')
  const report = {
    schemaVersion: 1,
    generatedAt: '2026-07-10T12:00:01.000Z',
    scenario: 'record-4k',
    mode: 'gate',
    verdict: 'pass'
  }

  it('requires a fresh passing child verdict in gate mode', () => {
    assert.equal(
      evaluateChildPerformanceRun({
        exit: { code: 0, signal: null, error: null },
        report,
        startedAtMs,
        mode: 'gate',
        expectedScenario: 'record-4k'
      }).ok,
      true
    )

    assert.deepEqual(
      evaluateChildPerformanceRun({
        exit: { code: 0, signal: null, error: null },
        report: { ...report, verdict: 'fail' },
        startedAtMs,
        mode: 'gate',
        expectedScenario: 'record-4k'
      }).failures,
      ['child performance verdict was fail; expected pass']
    )
  })

  it('rejects stale or missing child reports even when the command exits zero', () => {
    assert.deepEqual(
      evaluateChildPerformanceRun({
        exit: { code: 0, signal: null, error: null },
        report: { ...report, generatedAt: '2026-07-10T11:59:00.000Z' },
        startedAtMs,
        mode: 'report-only'
      }).failures,
      ['scenario did not produce a fresh versioned child performance report']
    )
  })

  it('accepts an observation only in report-only mode', () => {
    const observation = { ...report, mode: 'report-only', verdict: 'observation' }

    assert.equal(
      evaluateChildPerformanceRun({
        exit: { code: 0, signal: null, error: null },
        report: observation,
        startedAtMs,
        mode: 'report-only',
        expectedScenario: 'record-4k'
      }).ok,
      true
    )
    assert.deepEqual(
      evaluateChildPerformanceRun({
        exit: { code: 0, signal: null, error: null },
        report: { ...observation, mode: 'gate' },
        startedAtMs,
        mode: 'gate',
        expectedScenario: 'record-4k'
      }).failures,
      ['child performance verdict was observation; expected pass']
    )
    assert.deepEqual(
      evaluateChildPerformanceRun({
        exit: { code: 0, signal: null, error: null },
        report: { ...observation, verdict: 'fail' },
        startedAtMs,
        mode: 'report-only',
        expectedScenario: 'record-4k'
      }).failures,
      ['child performance verdict was fail; expected pass or observation']
    )
  })
})

describe('packaged performance provenance', () => {
  const commit = 'a'.repeat(40)
  const executableSha256 = 'b'.repeat(64)
  const packagePayloadSha256 = 'c'.repeat(64)
  const expected = {
    commit,
    dirty: false,
    buildMode: 'packaged',
    expectedBuildMode: 'packaged',
    runNonce: 'run-1234567890',
    hardwareClass: 'github-hosted-macos-15-arm64-standard',
    powerAssertion: 'caffeinate:-d,-i,-s',
    powerAssertionVerified: false,
    executable: { sha256: executableSha256 },
    packagePayload: { sha256: packagePayloadSha256 }
  }

  it('accepts only the same packaged bytes, nonce, and clean commit', () => {
    assert.deepEqual(
      evaluateChildPerformanceMetadata({
        actual: { ...expected, powerAssertionVerified: true },
        expected,
        requireCleanProvenance: true
      }),
      []
    )
    const failures = evaluateChildPerformanceMetadata({
      actual: {
        ...expected,
        commit: 'c'.repeat(40),
        dirty: true,
        buildMode: 'development',
        expectedBuildMode: 'development',
        runNonce: 'wrong-run',
        hardwareClass: 'wrong-hardware',
        powerAssertion: null,
        powerAssertionVerified: false,
        executable: { sha256: 'd'.repeat(64) },
        packagePayload: { sha256: 'e'.repeat(64) }
      },
      expected,
      requireCleanProvenance: true
    })

    assert.ok(failures.some((failure) => /child expected build mode/.test(failure)))
    assert.ok(failures.some((failure) => /child build mode/.test(failure)))
    assert.ok(failures.some((failure) => /run nonce/.test(failure)))
    assert.ok(failures.some((failure) => /hardware class/.test(failure)))
    assert.ok(failures.some((failure) => /power assertion/.test(failure)))
    assert.ok(failures.some((failure) => /did not match wrapper commit/.test(failure)))
    assert.ok(failures.some((failure) => /child commit provenance was dirty/.test(failure)))
    assert.ok(failures.some((failure) => /SHA-256 did not match/.test(failure)))
    assert.ok(failures.some((failure) => /app payload SHA-256 did not match/.test(failure)))
  })

  it('hashes the exact executable bytes recorded by packaged reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videorc-performance-sha-'))
    const executable = join(root, 'Videorc')
    try {
      await writeFile(executable, 'videorc packaged bytes')
      assert.equal(
        await sha256File(executable),
        '84095fe89e65cfb9ff92811636e589824630abaac01f8deba62668bb19da1ca2'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds every performance-critical packaged executable into one signed payload identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videorc-performance-payload-'))
    const executable = join(root, 'Videorc.app', 'Contents', 'MacOS', 'Videorc')
    const resources = join(root, 'Videorc.app', 'Contents', 'Resources')
    const framework = join(
      root,
      'Videorc.app',
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Electron Framework'
    )
    try {
      await mkdir(join(root, 'Videorc.app', 'Contents', 'MacOS'), { recursive: true })
      await mkdir(join(resources, 'ffmpeg', 'bin'), { recursive: true })
      await mkdir(dirname(framework), { recursive: true })
      await writeFile(executable, 'generic electron launcher')
      await Promise.all([
        writeFile(join(resources, 'app.asar'), 'renderer and main bytes'),
        writeFile(join(resources, 'videorc-backend'), 'backend bytes'),
        writeFile(join(resources, 'native_preview_host_helper'), 'helper bytes'),
        writeFile(join(resources, 'videorc_native_preview.node'), 'native addon bytes'),
        writeFile(join(resources, 'ffmpeg', 'bin', 'ffmpeg'), 'ffmpeg bytes'),
        writeFile(join(resources, 'ffmpeg', 'bin', 'ffprobe'), 'ffprobe bytes'),
        writeFile(framework, 'electron framework bytes')
      ])

      const signedIdentity = async (path) => (await sha256File(path)).slice(0, 40)
      const first = await packagedAppPayloadIdentity(executable, {
        codeDirectoryHash: signedIdentity
      })
      await writeFile(join(resources, 'videorc-backend'), 'changed backend bytes')
      const second = await packagedAppPayloadIdentity(executable, {
        codeDirectoryHash: signedIdentity
      })

      assert.match(first.sha256, /^[0-9a-f]{64}$/)
      assert.notEqual(second.sha256, first.sha256)
      assert.deepEqual(
        first.components.map((component) => component.relativePath),
        [
          'MacOS/Videorc',
          'Resources/app.asar',
          'Resources/videorc-backend',
          'Resources/native_preview_host_helper',
          'Resources/videorc_native_preview.node',
          'Resources/ffmpeg/bin/ffmpeg',
          'Resources/ffmpeg/bin/ffprobe',
          'Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
        ]
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when a packaged Mach-O component is unsigned', async () => {
    const identity = await packagedAppPayloadIdentity('/tmp/Videorc.app/Contents/MacOS/Videorc', {
      sha256: async () => 'a'.repeat(64),
      codeDirectoryHash: async (path) => (path.endsWith('ffprobe') ? null : 'b'.repeat(40))
    })

    assert.equal(identity.sha256, null)
    assert.deepEqual(identity.unsignedComponents, ['Resources/ffmpeg/bin/ffprobe'])
  })

  it('binds the Windows Electron launcher and recording payload into one SHA-256 identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videorc-windows-performance-payload-'))
    const executable = join(root, 'Videorc.exe')
    const resources = join(root, 'resources')
    try {
      await mkdir(join(resources, 'ffmpeg', 'bin'), { recursive: true })
      await Promise.all([
        writeFile(executable, 'electron launcher'),
        writeFile(join(resources, 'app.asar'), 'renderer and main bytes'),
        writeFile(join(resources, 'videorc-backend.exe'), 'backend bytes'),
        writeFile(join(resources, 'ffmpeg', 'bin', 'ffmpeg.exe'), 'ffmpeg bytes'),
        writeFile(join(resources, 'ffmpeg', 'bin', 'ffprobe.exe'), 'ffprobe bytes')
      ])

      const first = await packagedAppPayloadIdentity(executable, { osPlatform: 'win32' })
      await writeFile(join(resources, 'videorc-backend.exe'), 'changed backend bytes')
      const second = await packagedAppPayloadIdentity(executable, { osPlatform: 'win32' })

      assert.match(first.sha256, /^[0-9a-f]{64}$/)
      assert.notEqual(second.sha256, first.sha256)
      assert.deepEqual(
        first.components.map((component) => component.relativePath),
        [
          'Videorc.exe',
          'resources/app.asar',
          'resources/videorc-backend.exe',
          'resources/ffmpeg/bin/ffmpeg.exe',
          'resources/ffmpeg/bin/ffprobe.exe'
        ]
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses Code Directory identity instead of signature-bearing raw bytes', () => {
    const components = [
      ['MacOS/Videorc', 'codesign-cdhash'],
      ['Resources/app.asar', 'sha256'],
      ['Resources/videorc-backend', 'codesign-cdhash'],
      ['Resources/native_preview_host_helper', 'codesign-cdhash'],
      ['Resources/videorc_native_preview.node', 'codesign-cdhash'],
      ['Resources/ffmpeg/bin/ffmpeg', 'codesign-cdhash'],
      ['Resources/ffmpeg/bin/ffprobe', 'codesign-cdhash'],
      ['Frameworks/Electron Framework.framework/Versions/A/Electron Framework', 'codesign-cdhash']
    ].map(([relativePath, identityKind], index) => ({
      relativePath,
      identityKind,
      identity: String(index + 1).repeat(identityKind === 'sha256' ? 64 : 40),
      sha256: String(index + 5).repeat(64)
    }))
    const resigned = components.map((component, index) => ({
      ...component,
      sha256: component.identityKind === 'sha256' ? component.sha256 : String(index + 1).repeat(64)
    }))

    assert.equal(
      packagedAppPayloadManifestSha256(resigned),
      packagedAppPayloadManifestSha256(components)
    )
  })
})

describe('createPerformanceReport', () => {
  it('produces a versioned machine-readable verdict', () => {
    const report = createPerformanceReport({
      scenario: 'native-preview',
      mode: 'gate',
      metadata: { commit: 'abc' },
      timing: { warmupMs: 1000, measurementMs: 5000 },
      metrics: { frames: 300 },
      checks: [{ ok: true, message: 'frames progressed' }]
    })

    assert.equal(report.schemaVersion, 1)
    assert.equal(report.verdict, 'pass')
    assert.equal(report.scenario, 'native-preview')
  })

  it('keeps report-only budget misses neutral instead of calling them passes', () => {
    const explicit = createPerformanceReport({
      scenario: 'native-preview',
      mode: 'report-only',
      checks: [observationCheck('renderer RSS exceeded the provisional budget')]
    })
    const legacy = createPerformanceReport({
      scenario: 'native-preview',
      mode: 'report-only',
      checks: [{ ok: true, message: 'report-only observation: RSS kept growing' }]
    })

    assert.equal(explicit.verdict, 'observation')
    assert.deepEqual(explicit.checks[0], {
      ok: null,
      status: 'observation',
      message: 'renderer RSS exceeded the provisional budget'
    })
    assert.equal(legacy.verdict, 'observation')
    assert.equal(legacy.checks[0].ok, null)
    assert.equal(legacy.checks[0].status, 'observation')
  })
})
