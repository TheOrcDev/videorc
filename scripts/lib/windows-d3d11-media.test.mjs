import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  WINDOWS_D3D11_AGGREGATE_SCHEMA,
  WINDOWS_D3D11_HOST_SCHEMA,
  WINDOWS_D3D11_MEDIA_STAGES,
  WINDOWS_D3D11_NATURAL_FALLBACK_SCENARIOS,
  WINDOWS_D3D11_PATH_SCHEMA,
  WINDOWS_D3D11_REQUIRED_RUST_TESTS,
  WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS,
  WINDOWS_D3D11_STAGE_PRODUCER_SCENARIOS,
  assertWindowsD3d11RustDiscovery,
  combineWindowsD3d11PathEvidence,
  createWindowsD3d11PathManifest,
  createWindowsD3d11StageReport,
  deriveWindowsD3d11HostIdentity,
  expectedWindowsD3d11Selection,
  mergeWindowsD3d11HostEvidence,
  normalizeWindowsD3d11InvariantSummary,
  parseWindowsD3d11MediaArgs,
  parseWindowsD3d11RustTestList,
  requiredWindowsD3d11StageAssertionIds,
  sha256CanonicalJson,
  validateWindowsD3d11Aggregate,
  validateWindowsD3d11HostManifest,
  validateWindowsD3d11PathManifest,
  validateWindowsD3d11StageReport,
  windowsD3d11StageProducerSpec
} from './windows-d3d11-media.mjs'

const SOURCE_COMMIT = '1'.repeat(40)
const INSTALLER_SHA256 = '2'.repeat(64)
const APP_SHA256 = '3'.repeat(64)
const PAYLOAD_SHA256 = '4'.repeat(64)
const BUDGET_SHA256 = '5'.repeat(64)
const CANDIDATE = Object.freeze({
  sourceCommit: SOURCE_COMMIT,
  installerSha256: INSTALLER_SHA256,
  appSha256: APP_SHA256,
  payloadSha256: PAYLOAD_SHA256
})

describe('Windows D3D11 selection environment contract', () => {
  it('enumerates the exact complete runner-owned selector set', () => {
    assert.deepEqual(WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS, [
      'VIDEORC_WINDOWS_D3D11_MEDIA',
      'VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA',
      'VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT',
      'VIDEORC_WINDOWS_REQUIRE_ENCODED_BRIDGE',
      'VIDEORC_WINDOWS_EXPECT_D3D11_FALLBACK',
      'VIDEORC_ENCODER_BRIDGE',
      'VIDEORC_RECORDING_ENCODER_BRIDGE',
      'VIDEORC_STREAMING_ENCODER_BRIDGE',
      'VIDEORC_WINDOWS_GRAPHICS_CAPTURE'
    ])
  })

  it('keeps the D3D11 runner rejection bound to the shared selector set', () => {
    const script = fileURLToPath(new URL('../smoke-windows-d3d11-media.mjs', import.meta.url))
    const source = readFileSync(script, 'utf8')
    assert.match(
      source,
      /const inherited = WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS\.filter\(\(key\) =>[\s\S]*?process\.env\[key\]\?\.trim\(\)/
    )
    assert.match(source, /assertSelectionEnvironmentIsRunnerOwned\(\)/)
  })
})

describe('Windows D3D11 media arguments', () => {
  it('accepts the package-manager argument separator used by documented pnpm commands', () => {
    assert.deepEqual(
      parseWindowsD3d11MediaArgs(['--', '--list']),
      parseWindowsD3d11MediaArgs(['--list'])
    )
    assert.throws(
      () => parseWindowsD3d11MediaArgs(['--list', '--']),
      /Only one D3D11 media operation|Unknown Windows D3D11 media argument/
    )
  })

  it('parses the exact forced, automatic-default, and natural gate forms', () => {
    const forced = parseWindowsD3d11MediaArgs([
      '--gate',
      '--bridge',
      'mf',
      '--require-bridge',
      '--d3d11',
      '--require-d3d11',
      '--profiles',
      '1080p30,1080p60',
      '--hardware-class',
      'nvidia-turing-floor',
      '--path-evidence',
      'forced',
      '--output',
      '/evidence/nvidia/forced'
    ])
    assert.equal(forced.operation, 'gate')
    assert.equal(forced.pathEvidence, 'forced')

    const automatic = parseWindowsD3d11MediaArgs([
      '--gate',
      '--profiles',
      '1080p30,1080p60',
      '--hardware-class',
      'intel-xe-integrated',
      '--path-evidence',
      'default',
      '--output',
      '/evidence/intel/default'
    ])
    assert.equal(automatic.bridge, null)
    assert.equal(automatic.d3d11, false)

    const natural = parseWindowsD3d11MediaArgs([
      '--gate',
      '--profiles',
      '1080p30',
      '--hardware-class',
      'unsupported-natural-fallback',
      '--expect-fallback',
      'natural',
      '--path-evidence',
      'natural',
      '--output',
      '/evidence/fallback/natural'
    ])
    assert.deepEqual(natural.profiles, ['1080p30'])
    assert.equal(natural.expectFallback, 'natural')
  })

  it('rejects malformed and cross-mode gate options before launch', () => {
    const invalid = [
      [['--stage'], /requires a non-empty/],
      [['--stage', 'capture'], /absolute --output/],
      [['--profiles', '1080p30,1080p30'], /duplicate/],
      [['--wat'], /Unknown/],
      [
        [
          '--gate',
          '--profiles',
          '1080p30,1080p60',
          '--hardware-class',
          'nvidia-turing-floor',
          '--path-evidence',
          'forced',
          '--output',
          '/evidence'
        ],
        /Forced evidence/
      ],
      [
        [
          '--gate',
          '--profiles',
          '1080p30',
          '--hardware-class',
          'intel-xe-integrated',
          '--path-evidence',
          'default',
          '--output',
          '/evidence'
        ],
        /profiles must be exactly/
      ],
      [
        [
          '--gate',
          '--profiles',
          '1080p30,1080p60',
          '--hardware-class',
          'intel-xe-integrated',
          '--path-evidence',
          'default',
          '--d3d11',
          '--output',
          '/evidence'
        ],
        /Default evidence/
      ],
      [
        [
          '--gate',
          '--profiles',
          '1080p30,1080p60',
          '--hardware-class',
          'unsupported-natural-fallback',
          '--expect-fallback',
          'natural',
          '--path-evidence',
          'natural',
          '--output',
          '/evidence'
        ],
        /profiles must be exactly/
      ],
      [
        [
          '--combine-path-evidence',
          '/one.json',
          '--hardware-class',
          'nvidia-turing-floor',
          '--output',
          '/evidence'
        ],
        /exactly two/
      ],
      [
        [
          '--finalize-fallback-evidence',
          '/one.json,/two.json',
          '--hardware-class',
          'unsupported-natural-fallback',
          '--output',
          '/evidence'
        ],
        /exactly one/
      ],
      [['--merge-evidence', '/one.json,/two.json', '--output', '/evidence'], /exactly three/]
    ]
    for (const [argv, pattern] of invalid) {
      assert.throws(() => parseWindowsD3d11MediaArgs(argv), pattern)
    }
  })
})

describe('Windows D3D11 Rust discovery', () => {
  const expected = WINDOWS_D3D11_REQUIRED_RUST_TESTS.contract

  it('extracts and exactly validates the maintained nonzero manifest', () => {
    const output = [
      'unrelated::test: test',
      ...expected.map((name) => `${name}: test`),
      '24 tests, 0 benchmarks'
    ].join('\n')
    assert.deepEqual(parseWindowsD3d11RustTestList(output), expected)
    assert.deepEqual(
      assertWindowsD3d11RustDiscovery(expected, {
        stage: 'contract',
        allowUnimplementedStages: true
      }),
      expected
    )
  })

  it('rejects compiled-out, missing, duplicate, and unexpected tests', () => {
    assert.throws(
      () =>
        assertWindowsD3d11RustDiscovery([], {
          stage: 'contract',
          allowUnimplementedStages: true
        }),
      /zero/
    )
    assert.throws(
      () =>
        assertWindowsD3d11RustDiscovery(expected.slice(1), {
          stage: 'contract',
          allowUnimplementedStages: true
        }),
      /missing/
    )
    assert.throws(
      () =>
        assertWindowsD3d11RustDiscovery([...expected, expected[0]], {
          stage: 'contract',
          allowUnimplementedStages: true
        }),
      /duplicate/
    )
    assert.throws(
      () =>
        assertWindowsD3d11RustDiscovery([...expected, 'windows_d3d11::surprise'], {
          stage: 'contract',
          allowUnimplementedStages: true
        }),
      /unexpected/
    )
  })

  it('treats an explicit null stage as the default preview depth', () => {
    // smoke-windows-d3d11-media.mjs forwards parseWindowsD3d11MediaArgs output
    // directly, so `--verify-windows-rust` without `--stage` reaches here with
    // an explicit null that must resolve to the 'preview' default.
    const expected = WINDOWS_D3D11_MEDIA_STAGES.slice(
      0,
      WINDOWS_D3D11_MEDIA_STAGES.indexOf('preview') + 1
    ).flatMap((name) => WINDOWS_D3D11_REQUIRED_RUST_TESTS[name])
    assert.deepEqual(
      assertWindowsD3d11RustDiscovery(expected, {
        stage: null,
        allowUnimplementedStages: true
      }),
      expected
    )
  })
})

describe('Windows D3D11 stage evidence', () => {
  it('validates actual-source report shape and rejects failed PASS assertions', () => {
    const report = createWindowsD3d11StageReport({
      stage: 'contract',
      assertions: [{ id: 'focused-windows-rust-tests', passed: true }]
    })
    assert.deepEqual(validateWindowsD3d11StageReport(report), [])
    const failed = structuredClone(report)
    failed.assertions[0].passed = false
    assert.match(validateWindowsD3d11StageReport(failed).join('\n'), /failed assertion/)
  })

  it('binds every physical stage to the installed packaged-app stream producer', () => {
    const script = fileURLToPath(new URL('../smoke-windows-d3d11-media.mjs', import.meta.url))
    assert.doesNotMatch(readFileSync(script, 'utf8'), /VIDEORC_WINDOWS_D3D11_STAGE_REPORT/)

    for (const [stage, scenario] of Object.entries(WINDOWS_D3D11_STAGE_PRODUCER_SCENARIOS)) {
      const spec = windowsD3d11StageProducerSpec({
        stage,
        output: `/evidence/${stage}/producer`
      })
      assert.equal(spec.producer, 'installed-packaged-stream-performance')
      assert.equal(spec.scenario, scenario)
      assert.deepEqual(spec.args, [
        '--scenario',
        scenario,
        '--runs',
        '1',
        '--bridge',
        'mf',
        '--require-bridge',
        '--d3d11',
        '--require-d3d11',
        '--path-evidence',
        'forced',
        '--video-only',
        '--output',
        `/evidence/${stage}/producer`
      ])
      assert.equal(requiredWindowsD3d11StageAssertionIds(stage).length, 8)
    }
  })
})

describe('Windows D3D11 hardware proof', () => {
  it('derives sanitized, deterministic NVIDIA/Intel/fallback identities', () => {
    const nvidia = hostIdentity('nvidia-turing-floor')
    const intel = hostIdentity('intel-xe-integrated')
    const fallback = hostIdentity('unsupported-natural-fallback')
    assert.equal(nvidia.vendor, 'nvidia')
    assert.equal(nvidia.observedClass, 'nvidia-turing-floor')
    assert.equal(intel.vendor, 'intel')
    assert.equal(intel.observedClass, 'intel-xe-integrated')
    assert.equal(fallback.observedClass, 'unsupported-natural-fallback')
    assert.equal(
      new Set([nvidia.fingerprintSha256, intel.fingerprintSha256, fallback.fingerprintSha256]).size,
      3
    )
    assert.equal(nvidia.fingerprintSha256, hostIdentity('nvidia-turing-floor').fingerprintSha256)
  })

  it('does not relabel an arbitrary same-vendor adapter as a supported class', () => {
    const identity = deriveWindowsD3d11HostIdentity({
      declaredClass: 'intel-xe-integrated',
      operatingSystem: windowsOs(),
      selectedScreenId: 'screen:dxgi:0000000000000002:0',
      selectedScreenDetail: 'Windows DXGI output DISPLAY1 on NVIDIA RTX 4090.',
      adapterLuid: '0000000000000002',
      settingsSha256: digest('wrong-class')
    })
    assert.equal(identity.vendor, 'nvidia')
    assert.equal(identity.observedClass, 'unsupported')
  })
})

describe('Windows D3D11 PATH_PASS validation', () => {
  it('binds every active run adapter role to the selected media authority', () => {
    const luid = '0000000000000042'
    const run = {
      selectedScreenAdapterLuid: luid,
      evidence: {
        context: { topology: 'record-plus-stream', previewOpen: false },
        pipeline: {
          d3d11: {
            adapterLuid: luid,
            captureAdapterLuid: luid,
            compositorAdapterLuid: luid,
            primaryEncoderAdapterLuid: luid,
            auxiliaryEncoderAdapterLuid: luid,
            cameraUploadFrames: 0,
            inputContinuityEvidence: { applicable: false, physicalInput: false }
          }
        }
      }
    }
    assert.equal(
      normalizeWindowsD3d11InvariantSummary([run], { pathEvidence: 'forced' })
        .adapterRolesMatchAuthority,
      true
    )
    run.evidence.pipeline.d3d11.primaryEncoderAdapterLuid = '0000000000000043'
    assert.equal(
      normalizeWindowsD3d11InvariantSummary([run], { pathEvidence: 'forced' })
        .adapterRolesMatchAuthority,
      false
    )
  })

  it('accepts strict supported and natural manifests', () => {
    assert.deepEqual(
      validateWindowsD3d11PathManifest(pathManifest('nvidia-turing-floor', 'forced')),
      []
    )
    assert.deepEqual(
      validateWindowsD3d11PathManifest(pathManifest('intel-xe-integrated', 'default')),
      []
    )
    const natural = pathManifest('unsupported-natural-fallback', 'natural')
    assert.deepEqual(validateWindowsD3d11PathManifest(natural), [])
    assert.equal(natural.selection.obsParityQualified, false)
    assert.deepEqual(natural.profiles, ['1080p30'])
    assert.equal(natural.evidence.scenarios.length, 12)
  })

  it('fails closed at every candidate, class, selection, budget, workload, path, and evidence boundary', () => {
    const mutations = [
      ['schema drift', (value) => (value.schema = 'other')],
      ['unknown top-level field', (value) => (value.surprise = true)],
      ['status', (value) => (value.status = 'PASS')],
      ['source commit', (value) => (value.candidate.sourceCommit = 'F'.repeat(40))],
      ['installer', (value) => (value.candidate.installerSha256 = 'F'.repeat(64))],
      ['app', (value) => (value.candidate.appSha256 = 'z'.repeat(64))],
      ['payload', (value) => (value.candidate.payloadSha256 = null)],
      ['declared class', (value) => (value.host.declaredClass = 'intel-xe-integrated')],
      ['observed class', (value) => (value.host.observedClass = 'unsupported')],
      ['vendor', (value) => (value.host.vendor = 'intel')],
      ['fingerprint', (value) => (value.host.fingerprintSha256 = 'a'.repeat(64))],
      ['class proof', (value) => (value.host.classProof.settingsSha256 = 'a'.repeat(64))],
      ['profile expansion', (value) => value.profiles.push('1080p30')],
      ['selection override', (value) => (value.selection.environment.d3d11Media = null)],
      ['effective media path', (value) => (value.selection.effectiveMediaPath = 'legacy-fallback')],
      ['OBS qualification', (value) => (value.selection.obsParityQualified = false)],
      ['budget path', (value) => (value.budget.path = 'relative.json')],
      ['budget hash', (value) => (value.budget.activeSha256 = 'A'.repeat(64))],
      ['resolved profile', (value) => value.budget.resolvedProfiles.pop()],
      [
        'resolved profile hash',
        (value) => (value.budget.resolvedProfileSetSha256 = 'a'.repeat(64))
      ],
      ['scenario profile', (value) => (value.workload.scenarios[0].profile = '1080p60')],
      ['scenario set hash', (value) => (value.workload.scenarioSetSha256 = 'a'.repeat(64))],
      ['settings hash', (value) => (value.workload.settingsSha256 = null)],
      ['adapter equality', (value) => (value.adapterProof.equal = false)],
      ['adapter LUID', (value) => (value.adapterProof.mediaAuthorityAdapterLuid = 'f'.repeat(16))],
      ['capture adapter', (value) => (value.adapterProof.captureAdapterLuid = 'f'.repeat(16))],
      ['adapter proof schema', (value) => (value.adapterProof.surprise = true)],
      ['readback', (value) => (value.invariants.captureReadbackFrames = 1)],
      ['CPU fallback', (value) => (value.invariants.compositorCpuFallbackFrames = 1)],
      ['system memory', (value) => (value.invariants.encoderSystemMemorySamples = 1)],
      ['raw video', (value) => (value.invariants.rawVideoCopiedFrames = 1)],
      ['BMP request', (value) => (value.invariants.previewBmpRequests = 1)],
      ['BMP bytes', (value) => (value.invariants.previewBmpBytes = 4)],
      ['texture import', (value) => (value.invariants.textureImportFrames = 0)],
      ['GPU samples', (value) => (value.invariants.encoderGpuSamples = 0)],
      ['cursor', (value) => (value.invariants.cursorCorrect = false)],
      ['input', (value) => (value.invariants.inputContinuity = false)],
      [
        'physical-input contract',
        (value) => (value.invariants.physicalInputContractPassed = false)
      ],
      ['camera contract', (value) => (value.invariants.cameraUploadsMatchScenarios = false)],
      ['presenter adapter', (value) => (value.invariants.presenterSameAdapter = false)],
      ['presenter generation', (value) => (value.invariants.presenterGenerationBound = false)],
      ['presenter owner', (value) => (value.invariants.presenterOwnerBound = false)],
      ['presenter liveness', (value) => (value.invariants.presenterSourceLive = false)],
      ['first present', (value) => (value.invariants.presenterFirstPresentSucceeded = false)],
      ['present count', (value) => (value.invariants.presenterPresentsPositive = false)],
      ['p95 dispatch', (value) => (value.invariants.messageDispatchP95Ms = 50.01)],
      ['max dispatch', (value) => (value.invariants.messageDispatchMaxMs = 100.01)],
      ['media p95', (value) => (value.invariants.mediaCommandLagP95Ms = 50.01)],
      ['media max', (value) => (value.invariants.mediaCommandLagMaxMs = 100.01)],
      ['message batch', (value) => (value.invariants.maximumConsecutiveMessageBatch = 33)],
      ['media batch', (value) => (value.invariants.maximumConsecutiveMediaBatch = 33)],
      ['pool capacity', (value) => (value.invariants.texturePoolCapacityMinimum = 0)],
      ['pool use', (value) => (value.invariants.texturePoolInUseMaximum = 9)],
      ['pool pressure', (value) => (value.invariants.texturePoolPressureEvents = 1)],
      ['adapter mismatch', (value) => (value.invariants.adapterMismatches = 1)],
      ['device reset', (value) => (value.invariants.deviceResets = 1)],
      ['stale callback', (value) => (value.invariants.staleGenerationCallbacks = 1)],
      ['synchronization timeout', (value) => (value.invariants.synchronizationTimeouts = 1)],
      ['path transition', (value) => (value.invariants.pathIdentityChanges = 1)],
      ['fallback', (value) => (value.invariants.unexpectedFallbacks = 1)],
      ['aggregate evidence', (value) => (value.evidence.performanceAggregate.sha256 = null)],
      ['report bytes', (value) => (value.evidence.scenarios[0].report.sha256 = 'a'.repeat(64))],
      [
        'artifact bytes',
        (value) => (value.evidence.scenarios[0].artifacts.supportBundle.sha256 = 'a'.repeat(64))
      ],
      ['lifecycle record', (value) => (value.evidence.scenarios[0].lifecycle.verdict = 'FAIL')],
      ['fault record', (value) => (value.evidence.scenarios[0].fault.verdict = 'BLOCKED')],
      [
        'comparison record',
        (value) => (value.evidence.scenarios[0].comparison.status = 'NOT_APPLICABLE')
      ],
      [
        'physical input',
        (value) => (value.evidence.scenarios[0].inputContinuity.physicalInput = false)
      ],
      ['camera upload', (value) => (value.evidence.scenarios.at(-1).cameraUpload.frames = 0)],
      [
        'scenario aggregate hash',
        (value) => (value.evidence.scenarioEvidenceSha256 = 'a'.repeat(64))
      ],
      [
        'input aggregate hash',
        (value) => (value.evidence.inputContinuityEvidenceSha256 = 'a'.repeat(64))
      ],
      [
        'camera aggregate hash',
        (value) => (value.evidence.cameraUploadEvidenceSha256 = 'a'.repeat(64))
      ],
      ['runtime limitation', (value) => value.runtimeProofLimitations.push('missing-counter')]
    ]
    for (const [name, mutate] of mutations) {
      const value = structuredClone(pathManifest('nvidia-turing-floor', 'forced'))
      mutate(value)
      assert.notDeepEqual(validateWindowsD3d11PathManifest(value), [], name)
    }
  })

  it('rejects any attempt to authorize 60fps or OBS parity on natural fallback', () => {
    const natural = pathManifest('unsupported-natural-fallback', 'natural')
    natural.profiles.push('1080p60')
    assert.match(validateWindowsD3d11PathManifest(natural).join('\n'), /profiles/)
    const parity = pathManifest('unsupported-natural-fallback', 'natural')
    parity.selection.obsParityQualified = true
    assert.match(validateWindowsD3d11PathManifest(parity).join('\n'), /selection/)

    const adapterClaim = pathManifest('unsupported-natural-fallback', 'natural')
    adapterClaim.adapterProof.captureAdapterLuid = '0000000000000003'
    assert.match(
      validateWindowsD3d11PathManifest(adapterClaim).join('\n'),
      /must not claim D3D adapter equality/
    )
  })
})

describe('Windows D3D11 HOST_PASS combination', () => {
  it('requires and preserves forced+default exact-byte child evidence', () => {
    const forced = artifact(
      pathManifest('nvidia-turing-floor', 'forced'),
      '/evidence/nvidia/forced/path-manifest.json',
      'forced'
    )
    const automatic = artifact(
      pathManifest('nvidia-turing-floor', 'default'),
      '/evidence/nvidia/default/path-manifest.json',
      'default'
    )
    const host = combineWindowsD3d11PathEvidence([automatic, forced], {
      hardwareClass: 'nvidia-turing-floor',
      operation: 'combine-path-evidence'
    })
    assert.equal(host.schema, WINDOWS_D3D11_HOST_SCHEMA)
    assert.equal(host.status, 'HOST_PASS')
    assert.deepEqual(
      host.pathManifests.map(({ mode }) => mode),
      ['forced', 'default']
    )
    assert.deepEqual(
      host.pathManifests.map(({ sha256 }) => sha256),
      [forced.sha256, automatic.sha256]
    )
    assert.deepEqual(validateWindowsD3d11HostManifest(host), [])
  })

  it('rejects missing/duplicate mode, candidate/settings/scenario drift, and wrong finalizer', () => {
    const forced = artifact(
      pathManifest('nvidia-turing-floor', 'forced'),
      '/evidence/nvidia/forced/path-manifest.json',
      'forced'
    )
    const automatic = artifact(
      pathManifest('nvidia-turing-floor', 'default'),
      '/evidence/nvidia/default/path-manifest.json',
      'default'
    )
    assert.throws(
      () =>
        combineWindowsD3d11PathEvidence([forced], {
          hardwareClass: 'nvidia-turing-floor',
          operation: 'combine-path-evidence'
        }),
      /requires forced\+default/
    )
    assert.throws(
      () =>
        combineWindowsD3d11PathEvidence([forced, structuredClone(forced)], {
          hardwareClass: 'nvidia-turing-floor',
          operation: 'combine-path-evidence'
        }),
      /requires forced\+default/
    )
    for (const [name, mutate, pattern] of [
      ['candidate', (value) => (value.candidate.appSha256 = 'f'.repeat(64)), /candidate/],
      ['settings', (value) => (value.workload.settingsSha256 = 'f'.repeat(64)), /settingsSha256/],
      ['scenarios', (value) => (value.workload.scenarioSetSha256 = 'f'.repeat(64)), /scenario/]
    ]) {
      const changed = structuredClone(automatic)
      mutate(changed.document)
      assert.throws(
        () =>
          combineWindowsD3d11PathEvidence([forced, changed], {
            hardwareClass: 'nvidia-turing-floor',
            operation: 'combine-path-evidence'
          }),
        pattern,
        name
      )
    }
    assert.throws(
      () =>
        combineWindowsD3d11PathEvidence([forced, automatic], {
          hardwareClass: 'nvidia-turing-floor',
          operation: 'finalize-fallback-evidence'
        }),
      /Only the natural fallback/
    )
  })

  it('allows only the natural finalizer to write fallback HOST_PASS', () => {
    const natural = artifact(
      pathManifest('unsupported-natural-fallback', 'natural'),
      '/evidence/fallback/natural/path-manifest.json',
      'natural'
    )
    const host = combineWindowsD3d11PathEvidence([natural], {
      hardwareClass: 'unsupported-natural-fallback',
      operation: 'finalize-fallback-evidence'
    })
    assert.equal(host.obsParityQualified, false)
    assert.deepEqual(host.qualifiedProfiles, ['1080p30'])
    assert.deepEqual(
      host.pathManifests.map(({ mode }) => mode),
      ['natural']
    )
    assert.throws(
      () =>
        combineWindowsD3d11PathEvidence([natural], {
          hardwareClass: 'unsupported-natural-fallback',
          operation: 'combine-path-evidence'
        }),
      /only by the fallback finalizer/
    )
  })
})

describe('Windows D3D11 deterministic aggregate merge', () => {
  it('merges exactly NVIDIA + Intel + fallback independent of input order', () => {
    const nvidia = hostArtifact('nvidia-turing-floor')
    const intel = hostArtifact('intel-xe-integrated')
    const fallback = hostArtifact('unsupported-natural-fallback')
    const aggregate = mergeWindowsD3d11HostEvidence([fallback, nvidia, intel])
    const reordered = mergeWindowsD3d11HostEvidence([intel, fallback, nvidia])
    assert.equal(aggregate.schema, WINDOWS_D3D11_AGGREGATE_SCHEMA)
    assert.equal(aggregate.status, 'PASS')
    assert.deepEqual(
      aggregate.hosts.map(({ hardwareClass }) => hardwareClass),
      ['nvidia-turing-floor', 'intel-xe-integrated', 'unsupported-natural-fallback']
    )
    assert.equal(aggregate.aggregateSha256, reordered.aggregateSha256)
    assert.deepEqual(validateWindowsD3d11Aggregate(aggregate), [])
  })

  it('rejects class/vendor substitution, duplicate fingerprints, candidate/budget drift, and child claim drift', () => {
    const base = [
      hostArtifact('nvidia-turing-floor'),
      hostArtifact('intel-xe-integrated'),
      hostArtifact('unsupported-natural-fallback')
    ]
    const mutations = [
      ['vendor', (values) => (values[1].document.host.vendor = 'nvidia'), /host manifest|vendor/],
      [
        'candidate',
        (values) => (values[1].document.candidate.appSha256 = 'f'.repeat(64)),
        /candidate/
      ],
      [
        'budget',
        (values) => (values[1].document.budget.activeSha256 = 'f'.repeat(64)),
        /activeSha256/
      ],
      ['profiles', (values) => values[1].document.qualifiedProfiles.pop(), /profiles/],
      [
        'path mode',
        (values) => (values[1].document.pathManifests[1].mode = 'natural'),
        /pathManifests/
      ],
      [
        'fallback parity',
        (values) => (values[2].document.obsParityQualified = true),
        /obsParityQualified/
      ],
      [
        'child evidence',
        (values) => (values[0].document.pathManifests[0].faultEvidenceSha256 = null),
        /faultEvidenceSha256/
      ],
      [
        'failed child invariant',
        (values) => (values[0].document.pathManifests[0].invariants.deviceResets = 1),
        /deviceResets/
      ]
    ]
    for (const [name, mutate, pattern] of mutations) {
      const values = structuredClone(base)
      mutate(values)
      assert.throws(() => mergeWindowsD3d11HostEvidence(values), pattern, name)
    }

    const duplicate = structuredClone(base)
    const copiedInputs = structuredClone(duplicate[0].document.host.canonicalInputs)
    duplicate[2].document.host.canonicalInputs = copiedInputs
    duplicate[2].document.host.fingerprintSha256 = sha256CanonicalJson(copiedInputs)
    duplicate[2].document.host.classProof.settingsSha256 = copiedInputs.settingsSha256
    duplicate[2].document.host.classProof.adapterDescriptorSha256 =
      copiedInputs.adapterDescriptorSha256
    assert.throws(() => mergeWindowsD3d11HostEvidence(duplicate), /fingerprint/)
  })
})

describe('Windows D3D11 runner platform contract', () => {
  it('reports physical gate UNSUPPORTED off Windows and never emits PASS', () => {
    if (process.platform === 'win32') return
    const script = fileURLToPath(new URL('../smoke-windows-d3d11-media.mjs', import.meta.url))
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--gate',
        '--profiles',
        '1080p30,1080p60',
        '--hardware-class',
        'nvidia-turing-floor',
        '--path-evidence',
        'default',
        '--output',
        '/tmp/never-created-d3d11-evidence'
      ],
      { encoding: 'utf8' }
    )
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /UNSUPPORTED/)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /PATH_PASS|HOST_PASS/)
  })
})

function pathManifest(hardwareClass, mode) {
  const natural = mode === 'natural'
  const profiles = natural ? ['1080p30'] : ['1080p30', '1080p60']
  const host = hostIdentity(hardwareClass)
  const workloadScenarios = natural
    ? WINDOWS_D3D11_NATURAL_FALLBACK_SCENARIOS.map((id) => ({
        id,
        profile: '1080p30',
        repetitions: 3
      }))
    : [
        {
          id: '1080p30-stream-preview',
          profile: '1080p30',
          repetitions: 1,
          sourceComposition: 'screen-only',
          previewOpen: true
        },
        {
          id: '1080p30-stream-no-preview',
          profile: '1080p30',
          repetitions: 1,
          sourceComposition: 'screen-only',
          previewOpen: false
        },
        {
          id: '1080p60-screen-camera-stream-preview',
          profile: '1080p60',
          repetitions: 1,
          sourceComposition: 'screen-camera',
          previewOpen: true
        },
        {
          id: '1080p60-screen-camera-stream-no-preview',
          profile: '1080p60',
          repetitions: 1,
          sourceComposition: 'screen-camera',
          previewOpen: false
        }
      ]
  if (natural) {
    for (const scenario of workloadScenarios) {
      scenario.sourceComposition = 'screen-only'
      scenario.previewOpen = !scenario.id.endsWith('-no-preview')
    }
  }
  const resolvedProfiles = natural
    ? [
        {
          id: 'unsupported-natural-fallback-1080p30',
          profile: '1080p30',
          scenario: 'natural-fallback-policy',
          sha256: digest('natural-policy')
        }
      ]
    : workloadScenarios.map((scenario) => ({
        id: `${hardwareClass}-${scenario.id}`,
        profile: scenario.profile,
        scenario: scenario.id,
        sha256: digest(`${hardwareClass}-${scenario.id}-profile`)
      }))
  const scenarioRecords = workloadScenarios.flatMap((scenario) =>
    Array.from({ length: scenario.repetitions }, (_, index) => {
      const repetition = index + 1
      const reportSha256 = digest(`${hardwareClass}-${mode}-${scenario.id}-${repetition}-report`)
      const artifacts = {
        diagnostics: {
          path: `/evidence/${hardwareClass}/${mode}/${scenario.id}/${repetition}/diagnostics.json`,
          sha256: digest(`${hardwareClass}-${mode}-${scenario.id}-${repetition}-diagnostics`)
        },
        supportBundle: {
          path: `/evidence/${hardwareClass}/${mode}/${scenario.id}/${repetition}/support.json`,
          sha256: digest(`${hardwareClass}-${mode}-${scenario.id}-${repetition}-support`)
        }
      }
      const lifecycleSha256 = digest(
        `${hardwareClass}-${mode}-${scenario.id}-${repetition}-lifecycle`
      )
      const faultSha256 = digest(`${hardwareClass}-${mode}-${scenario.id}-${repetition}-fault`)
      const comparisonSha256 = digest(
        natural ? `${hardwareClass}-not-applicable-comparison` : `${hardwareClass}-comparison`
      )
      const inputContinuity = {
        verdict: !natural && scenario.previewOpen ? 'PASS' : 'NOT_REQUIRED',
        applicable: !natural && scenario.previewOpen,
        physicalInput: !natural && scenario.previewOpen,
        evidenceSha256: digest(
          `${hardwareClass}-${mode}-${scenario.id}-${repetition}-input-evidence`
        )
      }
      const cameraUpload = {
        sourceComposition: scenario.sourceComposition,
        frames: scenario.sourceComposition === 'screen-camera' ? 300 : 0
      }
      cameraUpload.sha256 = sha256CanonicalJson(cameraUpload)
      return {
        id: scenario.id,
        repetition,
        profile: scenario.profile,
        sourceComposition: scenario.sourceComposition,
        previewOpen: scenario.previewOpen,
        report: {
          path: `/evidence/${hardwareClass}/${mode}/${scenario.id}/${repetition}/verdict.json`,
          sha256: reportSha256
        },
        scenarioSha256: sha256CanonicalJson({
          id: scenario.id,
          repetition,
          profile: scenario.profile,
          reportSha256,
          sourceComposition: scenario.sourceComposition,
          previewOpen: scenario.previewOpen
        }),
        artifacts,
        artifactSetSha256: sha256CanonicalJson(artifacts),
        supportBundleSha256: artifacts.supportBundle.sha256,
        lifecycle: { verdict: 'PASS', sha256: lifecycleSha256 },
        lifecycleSha256,
        fault: { verdict: 'PASS', sha256: faultSha256 },
        faultSha256,
        comparison: {
          status: natural ? 'NOT_APPLICABLE' : 'BOUND',
          sha256: comparisonSha256
        },
        comparisonSha256,
        inputContinuity,
        inputContinuitySha256: sha256CanonicalJson(inputContinuity),
        cameraUpload,
        cameraUploadSha256: cameraUpload.sha256
      }
    })
  )
  const evidence = {
    performanceAggregate: {
      path: `/evidence/${hardwareClass}/${mode}/performance/aggregate.json`,
      sha256: digest(`${hardwareClass}-${mode}-aggregate`)
    },
    scenarios: scenarioRecords,
    scenarioEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ scenarioSha256 }) => scenarioSha256)
    ),
    artifactEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ artifactSetSha256 }) => artifactSetSha256)
    ),
    supportBundleEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ supportBundleSha256 }) => supportBundleSha256)
    ),
    lifecycleEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ lifecycleSha256 }) => lifecycleSha256)
    ),
    faultEvidenceSha256: sha256CanonicalJson(scenarioRecords.map(({ faultSha256 }) => faultSha256)),
    comparisonEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ comparisonSha256 }) => comparisonSha256)
    ),
    inputContinuityEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ inputContinuitySha256 }) => inputContinuitySha256)
    ),
    cameraUploadEvidenceSha256: sha256CanonicalJson(
      scenarioRecords.map(({ cameraUploadSha256 }) => cameraUploadSha256)
    )
  }
  const scenarioCoordinates = workloadScenarios.map(
    ({ id, profile, repetitions, sourceComposition, previewOpen }) => ({
      id,
      profile,
      repetitions,
      sourceComposition,
      previewOpen
    })
  )
  return createWindowsD3d11PathManifest({
    createdAt: '2026-07-30T12:00:00.000Z',
    candidate: structuredClone(CANDIDATE),
    host,
    profiles,
    selection: expectedWindowsD3d11Selection(mode),
    budget: {
      path: '/evidence/windows-d3d11-performance-budget.json',
      activeSha256: BUDGET_SHA256,
      resolvedProfiles,
      resolvedProfileSetSha256: sha256CanonicalJson(resolvedProfiles)
    },
    workload: {
      scenarios: workloadScenarios,
      scenarioSetSha256: sha256CanonicalJson(workloadScenarios),
      scenarioCoordinatesSha256: sha256CanonicalJson(scenarioCoordinates),
      settingsSha256: digest(`${hardwareClass}-workload-settings`)
    },
    adapterProof: natural
      ? {
          scope: 'named-natural-fallback-without-d3d-authority',
          perRoleLuidsAvailable: false,
          selectedScreenAdapterLuid: null,
          mediaAuthorityAdapterLuid: null,
          captureAdapterLuid: null,
          compositorAdapterLuid: null,
          primaryEncoderAdapterLuid: null,
          auxiliaryEncoderAdapterLuid: null,
          equal: null
        }
      : {
          scope: 'selected-dxgi-display-plus-per-role-session-authority',
          perRoleLuidsAvailable: true,
          selectedScreenAdapterLuid: host.canonicalInputs.adapterLuid,
          mediaAuthorityAdapterLuid: host.canonicalInputs.adapterLuid,
          captureAdapterLuid: host.canonicalInputs.adapterLuid,
          compositorAdapterLuid: host.canonicalInputs.adapterLuid,
          primaryEncoderAdapterLuid: host.canonicalInputs.adapterLuid,
          auxiliaryEncoderAdapterLuid: null,
          equal: true
        },
    invariants: invariantFixture({ natural }),
    evidence,
    runtimeProofLimitations: []
  })
}

function invariantFixture({ natural }) {
  return {
    adapterLuidMatchesSelectedScreen: true,
    adapterRolesMatchAuthority: true,
    presenterSameAdapter: true,
    presenterGenerationBound: true,
    presenterOwnerBound: true,
    presenterSourceLive: true,
    presenterFirstPresentSucceeded: true,
    presenterPresentsPositive: true,
    captureReadbackFrames: 0,
    compositorCpuFallbackFrames: 0,
    encoderSystemMemorySamples: natural ? 1 : 0,
    rawVideoCopiedFrames: natural ? 300 : 0,
    previewBmpRequests: natural ? 300 : 0,
    previewBmpBytes: natural ? 1_000_000 : 0,
    textureImportFrames: natural ? 0 : 10_000,
    encoderGpuSamples: natural ? 0 : 10_000,
    cursorCorrect: true,
    inputContinuity: true,
    physicalInputContractPassed: true,
    cameraUploadsMatchScenarios: true,
    messageDispatchP95Ms: natural ? null : 49,
    messageDispatchMaxMs: natural ? null : 99,
    mediaCommandLagP95Ms: natural ? null : 49,
    mediaCommandLagMaxMs: natural ? null : 99,
    maximumConsecutiveMessageBatch: natural ? null : 32,
    maximumConsecutiveMediaBatch: natural ? null : 32,
    texturePoolCapacityMinimum: natural ? null : 8,
    texturePoolInUseMaximum: natural ? null : 7,
    texturePoolPressureEvents: 0,
    adapterMismatches: 0,
    deviceResets: 0,
    staleGenerationCallbacks: 0,
    synchronizationTimeouts: 0,
    pathIdentityChanges: 0,
    unexpectedFallbacks: 0,
    namedNaturalFallback: natural
  }
}

function hostIdentity(hardwareClass) {
  const details = {
    'nvidia-turing-floor': 'Windows DXGI output DISPLAY1 on NVIDIA GeForce GTX 1650 SUPER.',
    'intel-xe-integrated': 'Windows DXGI output DISPLAY1 on Intel(R) Iris(R) Xe Graphics.',
    'unsupported-natural-fallback': 'Windows DXGI output DISPLAY1 on AMD Radeon RX 560.'
  }
  const adapterLuid = {
    'nvidia-turing-floor': '0000000000000001',
    'intel-xe-integrated': '0000000000000002',
    'unsupported-natural-fallback': '0000000000000003'
  }[hardwareClass]
  return deriveWindowsD3d11HostIdentity({
    declaredClass: hardwareClass,
    operatingSystem: windowsOs(),
    selectedScreenId: `screen:dxgi:${adapterLuid}:0`,
    selectedScreenDetail: details[hardwareClass],
    adapterLuid,
    settingsSha256: digest(`${hardwareClass}-screen-settings`)
  })
}

function hostArtifact(hardwareClass) {
  const paths =
    hardwareClass === 'unsupported-natural-fallback'
      ? [
          artifact(
            pathManifest(hardwareClass, 'natural'),
            `/evidence/${hardwareClass}/natural/path-manifest.json`,
            `${hardwareClass}-natural-child`
          )
        ]
      : [
          artifact(
            pathManifest(hardwareClass, 'forced'),
            `/evidence/${hardwareClass}/forced/path-manifest.json`,
            `${hardwareClass}-forced-child`
          ),
          artifact(
            pathManifest(hardwareClass, 'default'),
            `/evidence/${hardwareClass}/default/path-manifest.json`,
            `${hardwareClass}-default-child`
          )
        ]
  const document = combineWindowsD3d11PathEvidence(paths, {
    hardwareClass,
    operation:
      hardwareClass === 'unsupported-natural-fallback'
        ? 'finalize-fallback-evidence'
        : 'combine-path-evidence'
  })
  return artifact(
    document,
    `/evidence/${hardwareClass}/host-manifest.json`,
    `${hardwareClass}-host`
  )
}

function artifact(document, path, seed) {
  return { document, path, sha256: digest(seed) }
}

function windowsOs() {
  return { platform: 'win32', arch: 'x64', release: '10.0.26100' }
}

function digest(seed) {
  return sha256CanonicalJson({ seed })
}
