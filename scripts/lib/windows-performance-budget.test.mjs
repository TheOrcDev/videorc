import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import {
  attachWindowsNaturalFallbackPolicy,
  evaluateWindowsPerformanceBudget,
  loadWindowsPerformanceBudget,
  WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND,
  WINDOWS_D3D11_PERFORMANCE_SCENARIOS,
  validateWindowsPerformanceBudget
} from './windows-performance-budget.mjs'

describe('Windows performance budgets', () => {
  it('requires a reviewed Windows hardware class and exact scenario timing', async () => {
    const document = budgetDocument()
    const active = await loadWindowsPerformanceBudget({
      path: '/tmp/windows-budget.json',
      profileId: 'win11-lab-1080p',
      context: context(),
      read: async () => JSON.stringify(document)
    })
    assert.equal(active.profile.id, 'win11-lab-1080p')

    await assert.rejects(
      loadWindowsPerformanceBudget({
        path: '/tmp/windows-budget.json',
        context: { ...context(), hardwareClass: 'other-device' },
        read: async () => JSON.stringify(document)
      }),
      /did not contain a profile for scenario=windows-proof-recording-1080p, hardwareClass=other-device/
    )
  })

  it('fails closed when the runtime packaged payload is missing or changed', async () => {
    const document = budgetDocument()
    const load = (candidatePayloadSha256) =>
      loadWindowsPerformanceBudget({
        path: '/tmp/windows-budget.json',
        profileId: 'win11-lab-1080p',
        context: { ...context(), candidatePayloadSha256 },
        read: async () => JSON.stringify(document)
      })

    await assert.rejects(load(undefined), /candidatePayloadSha256 missing was not a lowercase/)
    await assert.rejects(load('D'.repeat(64)), /candidatePayloadSha256 D+ was not a lowercase/)
    await assert.rejects(load('f'.repeat(64)), /candidatePayloadSha256 f+ != d+/)
  })

  it('requires one lowercase packaged-payload digest at the budget and every profile', () => {
    const missing = budgetDocument()
    delete missing.candidatePayloadSha256
    delete missing.profiles[0].candidatePayloadSha256
    assert.deepEqual(validateWindowsPerformanceBudget(missing), [
      'candidatePayloadSha256 must be a lowercase SHA-256 digest',
      'profile 1 candidatePayloadSha256 must be a lowercase SHA-256 digest'
    ])

    const uppercase = budgetDocument()
    uppercase.candidatePayloadSha256 = uppercase.candidatePayloadSha256.toUpperCase()
    uppercase.profiles[0].candidatePayloadSha256 =
      uppercase.profiles[0].candidatePayloadSha256.toUpperCase()
    assert.deepEqual(validateWindowsPerformanceBudget(uppercase), [
      'candidatePayloadSha256 must be a lowercase SHA-256 digest',
      'profile 1 candidatePayloadSha256 must be a lowercase SHA-256 digest'
    ])

    const mismatched = budgetDocument()
    mismatched.profiles[0].candidatePayloadSha256 = 'f'.repeat(64)
    assert.deepEqual(validateWindowsPerformanceBudget(mismatched), [
      'profile 1 candidatePayloadSha256 did not match the budget candidate payload'
    ])
  })

  it('fails an over-budget per-role CPU/RSS or BMP cadence metric', () => {
    const profile = budgetDocument().profiles[0]
    assert.deepEqual(evaluateWindowsPerformanceBudget(profile, passingMetrics()), [])

    const failures = evaluateWindowsPerformanceBudget(profile, {
      ...passingMetrics(),
      bmp: { ...passingMetrics().bmp, intervalP95Ms: 201 },
      processTree: {
        ...passingMetrics().processTree,
        cpu: {
          summary: {
            byRole: {
              ...passingMetrics().processTree.cpu.summary.byRole,
              backend: { averagePercent: 10, p95Percent: 91 }
            }
          }
        }
      }
    })
    assert.deepEqual(failures, [
      'BMP polling interval p95 201 exceeded 200',
      'backend p95 CPU 91 exceeded 90'
    ])
  })

  it('rejects a profile without retained three-run calibration evidence', () => {
    const document = budgetDocument()
    document.profiles[0].evidence.runCount = 2
    document.profiles[0].evidence.reportPaths = ['one.json', 'two.json']
    assert.deepEqual(validateWindowsPerformanceBudget(document), [
      'profile 1 evidence runCount must be 3',
      'profile 1 evidence must retain three report paths'
    ])
  })

  it('requires three non-empty, distinct calibration report paths', () => {
    const emptyPathDocument = budgetDocument()
    emptyPathDocument.profiles[0].evidence.reportPaths = ['one.json', ' ', 'three.json']
    assert.deepEqual(validateWindowsPerformanceBudget(emptyPathDocument), [
      'profile 1 evidence must retain three report paths'
    ])

    const duplicatePathDocument = budgetDocument()
    duplicatePathDocument.profiles[0].evidence.reportPaths = ['one.json', 'two.json', ' one.json ']
    assert.deepEqual(validateWindowsPerformanceBudget(duplicatePathDocument), [
      'profile 1 evidence must retain three report paths'
    ])

    const aliasedPathDocument = budgetDocument()
    aliasedPathDocument.profiles[0].evidence.reportPaths = [
      'reports/one.json',
      './reports/one.json',
      'reports/nested/../one.json'
    ]
    assert.deepEqual(validateWindowsPerformanceBudget(aliasedPathDocument), [
      'profile 1 evidence must retain three report paths'
    ])
  })

  it('requires distinct calibration report digests for comparison-bound evidence', () => {
    const document = comparisonBudgetDocument()
    document.profiles[0].evidence.reportSha256 = ['c'.repeat(64), 'c'.repeat(64), 'e'.repeat(64)]
    assert.deepEqual(validateWindowsPerformanceBudget(document), [
      'profile 1 evidence reportSha256 must retain 3 SHA-256 digests'
    ])
  })

  it('keeps comparison-derived budgets draft until a human review activates them', () => {
    const document = comparisonBudgetDocument()
    document.status = 'draft'
    delete document.reviewedBy
    delete document.reviewedAt

    assert.deepEqual(validateWindowsPerformanceBudget(document, { allowDraft: true }), [])
    assert.deepEqual(validateWindowsPerformanceBudget(document), ['status must be active'])

    document.status = 'active'
    assert.deepEqual(validateWindowsPerformanceBudget(document), [
      'active comparison budget reviewedBy was missing',
      'active comparison budget reviewedAt was missing'
    ])
    document.reviewedBy = 'Release reviewer'
    document.reviewedAt = '2026-07-29T12:00:00.000Z'
    assert.deepEqual(validateWindowsPerformanceBudget(document), [])
  })

  it('accepts a single retained calibration run for the 1080p60 A/V endurance scenario', () => {
    const document = budgetDocument()
    document.profiles[0].scope.scenario = '1080p60-av-endurance'
    document.profiles[0].scope.timing.measurementMs = 600_000
    document.profiles[0].evidence.runCount = 1
    document.profiles[0].evidence.reportPaths = ['endurance.json']

    assert.deepEqual(validateWindowsPerformanceBudget(document), [])
  })

  it('binds every profile to the top-level comparison paths and normalized digests', () => {
    const document = comparisonBudgetDocument()
    document.profiles[0].candidateSha256 = document.candidateSha256.toUpperCase()
    document.profiles[0].evidence.comparisonSha256 = document.comparison.reportSha256.map(
      (digest) => digest.toUpperCase()
    )
    assert.deepEqual(validateWindowsPerformanceBudget(document), [])

    document.profiles[0].evidence.comparisonPaths = [
      ...document.comparison.reportPaths.slice(1),
      document.comparison.reportPaths[0]
    ]
    document.profiles[0].evidence.comparisonSha256 = [
      ...document.comparison.reportSha256.slice(1),
      document.comparison.reportSha256[0]
    ]
    assert.deepEqual(validateWindowsPerformanceBudget(document), [
      'profile 1 evidence comparisonPaths did not match the budget comparison',
      'profile 1 evidence comparisonSha256 did not match the budget comparison'
    ])
  })

  it('resolves and verifies every comparison and calibration artifact', async () => {
    const document = comparisonBudgetDocument()
    const calls = []
    await loadWindowsPerformanceBudget({
      path: '/tmp/acceptance/windows-budget.json',
      profileId: document.profiles[0].id,
      context: document.profiles[0].scope,
      read: async () => JSON.stringify(document),
      verifyArtifact: async (reference) => {
        calls.push(reference)
        return reference.expectedSha256.toUpperCase()
      }
    })

    assert.equal(calls.length, 11)
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        '/tmp/acceptance/comparison/aggregate.json',
        ...Array.from(
          { length: 6 },
          (_, index) => `/tmp/acceptance/comparison/run-${index + 1}.json`
        ),
        '/tmp/acceptance/calibration/aggregate.json',
        '/tmp/acceptance/one.json',
        '/tmp/acceptance/two.json',
        '/tmp/acceptance/three.json'
      ]
    )
  })

  it('rehashes the exact referenced artifact bytes by default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-windows-budget-'))
    try {
      const document = comparisonBudgetDocument()
      const budgetPath = join(directory, 'windows-budget.json')
      const references = [
        {
          path: document.comparison.aggregatePath,
          assign: (digest) => {
            document.comparison.aggregateSha256 = digest
          }
        },
        ...document.comparison.reportPaths.map((path, index) => ({
          path,
          assign: (digest) => {
            document.comparison.reportSha256[index] = digest
            document.profiles[0].evidence.comparisonSha256[index] = digest
          }
        })),
        {
          path: document.profiles[0].evidence.calibrationPath,
          assign: (digest) => {
            document.profiles[0].evidence.calibrationSha256 = digest
          }
        },
        ...document.profiles[0].evidence.reportPaths.map((path, index) => ({
          path,
          assign: (digest) => {
            document.profiles[0].evidence.reportSha256[index] = digest
          }
        }))
      ]
      for (const [index, reference] of references.entries()) {
        const artifactPath = join(directory, reference.path)
        await mkdir(dirname(artifactPath), { recursive: true })
        const bytes = `artifact-${index + 1}`
        await writeFile(artifactPath, bytes)
        reference.assign(createHash('sha256').update(bytes).digest('hex'))
      }
      await writeFile(budgetPath, JSON.stringify(document))

      const loaded = await loadWindowsPerformanceBudget({
        path: budgetPath,
        profileId: document.profiles[0].id,
        context: document.profiles[0].scope
      })
      assert.equal(loaded.profile.id, document.profiles[0].id)

      await writeFile(join(directory, document.profiles[0].evidence.reportPaths[0]), 'tampered')
      await assert.rejects(
        loadWindowsPerformanceBudget({
          path: budgetPath,
          profileId: document.profiles[0].id,
          context: document.profiles[0].scope
        }),
        /calibration report 1 SHA-256 did not match/
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('evaluates comparison-bound total CPU, GPU, and disabled BMP thresholds', () => {
    const profile = comparisonBudgetDocument().profiles[0]
    const metrics = {
      ...passingMetrics(),
      bmp: { requestCount: 0, bytes: 0 },
      gpu: {
        summary: {
          engineBusyP95Percent: 50,
          dedicatedMaxMiB: 400,
          sharedMaxMiB: 100
        }
      }
    }
    metrics.processTree.cpu.summary.totalP95Percent = 70
    assert.deepEqual(evaluateWindowsPerformanceBudget(profile, metrics), [])

    metrics.bmp.requestCount = 1
    metrics.gpu.summary.engineBusyP95Percent = 81
    metrics.processTree.cpu.summary.totalP95Percent = 91
    assert.deepEqual(evaluateWindowsPerformanceBudget(profile, metrics), [
      'total process-tree p95 CPU 91 exceeded 90',
      'BMP request count 1 exceeded 0',
      'GPU engine p95 81 exceeded 80'
    ])
  })
})

describe('Windows D3D11 performance budgets', () => {
  it('keeps derived evidence draft and rejects activation without natural fallback review', () => {
    const document = d3d11BudgetDocument({ active: false })
    assert.deepEqual(validateWindowsPerformanceBudget(document, { allowDraft: true }), [])
    assert.deepEqual(validateWindowsPerformanceBudget(document), ['status must be active'])

    document.status = 'active'
    document.activation = { allowed: true, reason: 'independent review complete' }
    assert.match(validateWindowsPerformanceBudget(document).join('\n'), /reviewedBy was missing/)
    assert.match(
      validateWindowsPerformanceBudget(document).join('\n'),
      /naturalFallbackPolicy was missing/
    )
  })

  it('accepts only the candidate-bound two-class 1080p30/60 active contract', () => {
    const document = d3d11BudgetDocument()
    assert.equal(document.kind, WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND)
    assert.deepEqual(validateWindowsPerformanceBudget(document), [])

    const positiveBmp = structuredClone(document)
    positiveBmp.profiles[0].thresholds.bmp.maximumRequests = 1
    assert.match(
      validateWindowsPerformanceBudget(positiveBmp).join('\n'),
      /disabled BMP thresholds must require zero/
    )

    const broaderProfile = structuredClone(document)
    broaderProfile.profiles[0].scope.profile = '1440p30'
    assert.match(
      validateWindowsPerformanceBudget(broaderProfile).join('\n'),
      /scope profile was not qualified/
    )

    const reusedHost = structuredClone(document)
    reusedHost.comparisonEvidence[1].fingerprint = reusedHost.comparisonEvidence[0].fingerprint
    assert.match(
      validateWindowsPerformanceBudget(reusedHost).join('\n'),
      /reused another physical host/
    )

    const endurance = document.profiles.find(
      ({ scope }) => scope.scenario === '1080p60-av-endurance'
    )
    assert.equal(endurance.evidence.reportPaths.length, 1)
  })

  it('resolves a D3D profile and natural fallback policy only for exact contexts', async () => {
    const document = d3d11BudgetDocument()
    const d3dProfile = document.profiles[0]
    const d3dContext = d3d11RuntimeContext(d3dProfile.scope, document.candidate)
    const loaded = await loadWindowsPerformanceBudget({
      path: '/tmp/windows-d3d11-budget.json',
      context: d3dContext,
      read: async () => JSON.stringify(document),
      verifyArtifact: async ({ expectedSha256 }) => expectedSha256
    })
    assert.equal(loaded.profile.id, d3dProfile.id)

    const fallback = await loadWindowsPerformanceBudget({
      path: '/tmp/windows-d3d11-budget.json',
      context: d3d11RuntimeContext(document.naturalFallbackPolicy.scope, document.candidate),
      read: async () => JSON.stringify(document),
      verifyArtifact: async ({ expectedSha256 }) => expectedSha256
    })
    assert.equal(fallback.profile.id, 'unsupported-natural-fallback-1080p30')

    await assert.rejects(
      loadWindowsPerformanceBudget({
        path: '/tmp/windows-d3d11-budget.json',
        context: { ...d3dContext, candidateSha256: 'f'.repeat(64) },
        read: async () => JSON.stringify(document),
        verifyArtifact: async ({ expectedSha256 }) => expectedSha256
      }),
      /runtime candidate identity did not match/
    )
    await assert.rejects(
      loadWindowsPerformanceBudget({
        path: '/tmp/windows-d3d11-budget.json',
        context: { ...d3dContext, profile: '4k30' },
        read: async () => JSON.stringify(document),
        verifyArtifact: async ({ expectedSha256 }) => expectedSha256
      }),
      /did not contain a profile/
    )
    await assert.rejects(
      loadWindowsPerformanceBudget({
        path: '/tmp/windows-d3d11-budget.json',
        context: { ...d3dContext, topology: 'record-plus-stream' },
        read: async () => JSON.stringify(document),
        verifyArtifact: async ({ expectedSha256 }) => expectedSha256
      }),
      /did not contain a profile/
    )
  })

  it('enforces zero-copy, cursor, input, and pump-latency invariants at evaluation', () => {
    const profile = d3d11BudgetDocument().profiles[0]
    const metrics = d3d11PassingMetrics()
    assert.deepEqual(evaluateWindowsPerformanceBudget(profile, metrics), [])

    metrics.d3d11.captureReadbackFrames = 1
    metrics.d3d11.cursorCorrect = false
    metrics.d3d11.messageDispatchMaxMs = 101
    assert.deepEqual(evaluateWindowsPerformanceBudget(profile, metrics), [
      'captureReadbackFrames 1 exceeded 0',
      'cursor correctness false did not equal true',
      'message dispatch maximum 101 exceeded 100'
    ])
  })

  it('derives but never self-activates the natural fallback policy from the full matrix', () => {
    const draft = d3d11BudgetDocument({ active: false })
    const calibration = naturalFallbackCalibration(draft.candidate)
    const updated = attachWindowsNaturalFallbackPolicy({
      document: draft,
      calibration
    })
    assert.equal(updated.status, 'draft')
    assert.equal(updated.activation.allowed, false)
    assert.equal(updated.naturalFallbackPolicy.evidence.reportPaths.length, 12)
    assert.deepEqual(updated.naturalFallbackPolicy.scope.topologies, [
      'stream-only',
      'record-plus-stream'
    ])
    assert.deepEqual(validateWindowsPerformanceBudget(updated, { allowDraft: true }), [])

    const incomplete = structuredClone(calibration)
    incomplete.runs.pop()
    assert.throws(
      () => attachWindowsNaturalFallbackPolicy({ document: draft, calibration: incomplete }),
      /exactly twelve matrix runs/
    )
    assert.throws(
      () => attachWindowsNaturalFallbackPolicy({ document: updated, calibration }),
      /already attached/
    )
  })
})

function context() {
  return {
    scenario: 'windows-proof-recording-1080p',
    hardwareClass: 'win11-x64-lab-a',
    profileClass: 'endurance',
    buildMode: 'packaged',
    candidatePayloadSha256: 'd'.repeat(64),
    operatingSystem: { platform: 'win32', arch: 'x64' },
    timing: { warmupMs: 60_000, measurementMs: 600_000, intervalMs: 1_000 }
  }
}

function d3d11BudgetDocument({ active = true } = {}) {
  const candidate = {
    sourceCommit: '1'.repeat(40),
    installerSha256: '2'.repeat(64),
    executableSha256: '3'.repeat(64),
    packagePayloadSha256: '4'.repeat(64)
  }
  const hardwareClasses = ['nvidia-turing-floor', 'intel-xe-integrated']
  const profiles = hardwareClasses.flatMap((hardwareClass, classIndex) =>
    WINDOWS_D3D11_PERFORMANCE_SCENARIOS.map((scenario, scenarioIndex) => {
      const ordinal = classIndex * WINDOWS_D3D11_PERFORMANCE_SCENARIOS.length + scenarioIndex
      return {
        id: `${hardwareClass}-${scenario.id}`,
        scope: {
          scenario: scenario.id,
          profile: scenario.profile,
          hardwareClass,
          profileClass: 'release',
          buildMode: 'packaged',
          operatingSystem: {
            platform: 'win32',
            arch: 'x64',
            release: '10.0.26100'
          },
          timing: {
            warmupMs: scenario.warmupMs,
            measurementMs: scenario.measurementMs,
            intervalMs: scenario.intervalMs
          },
          mediaPath: 'd3d11-native',
          topology: scenario.topology,
          sourceComposition: scenario.sourceComposition,
          previewOpen: scenario.previewOpen,
          ...(scenario.previewOpen
            ? {
                preview: {
                  transport: 'd3d11-shared-texture',
                  backing: 'directcomposition-swapchain',
                  hostKind: 'backend-d3d11-presenter'
                }
              }
            : {})
        },
        candidate,
        evidence: {
          calibrationPath: `C:\\evidence\\${hardwareClass}\\${scenario.id}\\aggregate.json`,
          calibrationSha256: `${5 + ordinal}`.repeat(64).slice(0, 64),
          reportPaths: Array.from(
            { length: scenario.repetitions },
            (_, index) => `C:\\evidence\\${hardwareClass}\\${scenario.id}\\run-${index + 1}.json`
          ),
          reportSha256: Array.from({ length: scenario.repetitions }, (_, index) =>
            `${10 + ordinal * 3 + index}`.repeat(64).slice(0, 64)
          ),
          comparisonPath: `C:\\evidence\\${hardwareClass}\\obs\\aggregate.json`,
          comparisonSha256: `${20 + classIndex}`.repeat(64).slice(0, 64)
        },
        invariants: {
          mediaPath: 'd3d11-native',
          captureReadbackFrames: 0,
          compositorCpuFallbackFrames: 0,
          rawVideoCopiedFrames: 0,
          encoderSystemMemorySamples: 0,
          previewBmpRequests: 0,
          previewBmpBytes: 0,
          cursorCorrect: true,
          inputContinuity: true,
          maximumMessageDispatchP95Ms: 50,
          maximumMessageDispatchMs: 100
        },
        thresholds: d3d11Thresholds()
      }
    })
  )
  return {
    schemaVersion: 1,
    kind: WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND,
    status: active ? 'active' : 'draft',
    generatedBy: 'smoke-windows-obs-side-by-side --derive-d3d11-budget',
    candidate,
    qualifiedProfiles: {
      'nvidia-turing-floor': ['1080p30', '1080p60'],
      'intel-xe-integrated': ['1080p30', '1080p60']
    },
    unqualifiedLivestreamProfiles: ['1440p30', '1440p60', '4k30', '4k60'],
    comparisonEvidence: hardwareClasses.map((hardwareClass, index) => ({
      hardwareClass,
      aggregatePath: `C:\\evidence\\${hardwareClass}\\obs\\aggregate.json`,
      aggregateSha256: `${20 + index}`.repeat(64).slice(0, 64),
      manifestSha256: `${22 + index}`.repeat(64).slice(0, 64),
      obsSha256: `${24 + index}`.repeat(64).slice(0, 64),
      obsVersion: '31.1.2',
      bootId: `boot-${index + 1}`,
      fingerprint: `${26 + index}`.repeat(64).slice(0, 64)
    })),
    profiles,
    naturalFallbackPolicy: active ? d3d11NaturalFallbackPolicy(candidate) : null,
    activation: active
      ? { allowed: true, reason: 'independent human review complete' }
      : {
          allowed: false,
          reason:
            'Draft requires retained natural-fallback policy evidence and independent human review.'
        },
    ...(active
      ? {
          reviewedBy: 'Windows release reviewer',
          reviewedAt: '2026-07-30T12:00:00.000Z'
        }
      : {})
  }
}

function d3d11NaturalFallbackPolicy(candidate) {
  return {
    id: 'unsupported-natural-fallback-1080p30',
    scope: {
      scenario: '1080p30-screen-only-stream',
      profile: '1080p30',
      hardwareClass: 'unsupported-natural-fallback',
      profileClass: 'release',
      buildMode: 'packaged',
      operatingSystem: {
        platform: 'win32',
        arch: 'x64',
        release: '10.0.26100'
      },
      timing: {
        warmupMs: 60_000,
        measurementMs: 180_000,
        intervalMs: 1_000
      },
      mediaPath: 'legacy-fallback',
      selectionMode: 'natural',
      topologies: ['stream-only', 'record-plus-stream'],
      previewModes: ['open', 'closed']
    },
    candidate,
    evidence: {
      calibrationPath: 'C:\\evidence\\fallback\\aggregate.json',
      calibrationSha256: 'a'.repeat(64),
      reportPaths: Array.from(
        { length: 12 },
        (_, index) => `C:\\evidence\\fallback\\run-${index + 1}.json`
      ),
      reportSha256: Array.from({ length: 12 }, (_, index) =>
        `${30 + index}`.repeat(64).slice(0, 64)
      )
    },
    observed: {
      fallbackReason: 'd3d11-fence-interface-unavailable',
      effectiveCaptureBackend: 'legacy-ffmpeg',
      effectiveEncoderBackend: 'software-x264'
    },
    invariants: {
      obsParityQualified: false,
      maximumFps: 30,
      maximumTotalRssSlopeMiBPerMinute: 5,
      maximumRoleRssSlopeMiBPerMinute: 2,
      minimumEncoderSpeedP05: 0.98,
      mediaVerdict: 'PASS',
      lifecycleVerdict: 'PASS',
      previewProofSurfaceVerdict: 'PASS'
    },
    thresholds: {
      ...d3d11Thresholds(),
      bmp: {
        mode: 'required',
        maximumIntervalP95Ms: 175,
        minimumAdvancedFrames: 10
      }
    }
  }
}

function d3d11Thresholds() {
  const role = {
    maximumRssMiB: 512,
    maximumRssSlopeMiBPerMinute: 2,
    maximumAverageCpuPercent: 80,
    maximumP95CpuPercent: 90
  }
  return {
    maximumTotalCpuP95Percent: 90,
    maximumTotalRssMiB: 2048,
    maximumTotalRssSlopeMiBPerMinute: 5,
    gpu: {
      maximumEngineP95Percent: 80,
      maximumDedicatedMiB: 600,
      maximumSharedMiB: 200
    },
    bmp: {
      mode: 'disabled',
      maximumRequests: 0,
      maximumBytes: 0
    },
    roles: Object.fromEntries(
      ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg'].map((name) => [
        name,
        role
      ])
    )
  }
}

function d3d11RuntimeContext(scope, candidate) {
  return {
    ...scope,
    ...(scope.hardwareClass === 'unsupported-natural-fallback'
      ? {
          scenario: '1080p30-stream-preview',
          topology: 'stream-only',
          previewOpen: true
        }
      : {}),
    sourceCommit: candidate.sourceCommit,
    installerSha256: candidate.installerSha256,
    candidateSha256: candidate.executableSha256,
    candidatePayloadSha256: candidate.packagePayloadSha256
  }
}

function d3d11PassingMetrics() {
  const metrics = passingMetrics()
  metrics.processTree.memory.summary.totalRss.slopePerMinute = 1024
  for (const role of Object.values(metrics.processTree.memory.summary.roles)) {
    role.slopeRssKbPerMinute = 1024
  }
  metrics.bmp = { requestCount: 0, bytes: 0 }
  metrics.gpu = {
    summary: {
      engineBusyP95Percent: 50,
      dedicatedMaxMiB: 400,
      sharedMaxMiB: 100
    }
  }
  metrics.processTree.cpu.summary.totalP95Percent = 70
  metrics.d3d11 = {
    captureReadbackFrames: 0,
    compositorCpuFallbackFrames: 0,
    rawVideoCopiedFrames: 0,
    encoderSystemMemorySamples: 0,
    cursorCorrect: true,
    inputContinuity: true,
    messageDispatchP95Ms: 30,
    messageDispatchMaxMs: 80
  }
  return metrics
}

function naturalFallbackCalibration(candidate) {
  const roles = ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg']
  const runs = []
  let index = 0
  for (const topology of ['stream-only', 'record-plus-stream']) {
    for (const previewOpen of [true, false]) {
      for (let repetition = 1; repetition <= 3; repetition += 1) {
        index += 1
        runs.push({
          topology,
          previewOpen,
          repetition,
          verdict: 'PASS',
          reportPath: `C:\\evidence\\fallback\\${topology}-${previewOpen ? 'open' : 'closed'}-${repetition}.json`,
          reportSha256: `${50 + index}`.repeat(64).slice(0, 64),
          observed: {
            fallbackReason: 'd3d11-fence-interface-unavailable',
            effectiveCaptureBackend: 'legacy-ffmpeg',
            effectiveEncoderBackend: 'software-x264'
          },
          mediaVerdict: 'PASS',
          lifecycleVerdict: 'PASS',
          previewProofSurfaceVerdict: 'PASS',
          encoderSpeedP05: 0.99,
          process: {
            cpuP95Percent: 65,
            rssMaxMiB: 900,
            rssSlopeMiBPerMinute: 4,
            roles: Object.fromEntries(
              roles.map((role, roleIndex) => [
                role,
                {
                  rssMaxMiB: 100 + roleIndex,
                  rssSlopeMiBPerMinute: 1.5,
                  cpuAveragePercent: 12 + roleIndex,
                  cpuP95Percent: 18 + roleIndex
                }
              ])
            )
          },
          gpu: {
            engineBusyP95Percent: 55,
            dedicatedMaxMiB: 400,
            sharedMaxMiB: 200
          },
          bmp: {
            intervalP95Ms: 125,
            advancedFrames: 200
          }
        })
      }
    }
  }
  return {
    schemaVersion: 1,
    kind: 'videorc.windows-natural-fallback-calibration',
    status: 'CALIBRATION',
    candidate,
    aggregatePath: 'C:\\evidence\\fallback\\aggregate.json',
    aggregateSha256: '9'.repeat(64),
    scope: {
      scenario: '1080p30-natural-fallback-matrix',
      profile: '1080p30',
      fps: 30,
      hardwareClass: 'unsupported-natural-fallback',
      profileClass: 'release',
      buildMode: 'packaged',
      operatingSystem: {
        platform: 'win32',
        arch: 'x64',
        release: '10.0.26100'
      },
      timing: {
        warmupMs: 60_000,
        measurementMs: 180_000,
        intervalMs: 1_000
      },
      mediaPath: 'legacy-fallback',
      selectionMode: 'natural',
      d3d11Requested: false,
      d3d11Required: false
    },
    runs
  }
}

function budgetDocument() {
  const roleThresholds = {
    maximumRssMiB: 512,
    maximumRssSlopeMiBPerMinute: 32,
    maximumAverageCpuPercent: 80,
    maximumP95CpuPercent: 90
  }
  return {
    schemaVersion: 1,
    kind: 'videorc.windows-performance-budget-set',
    status: 'active',
    candidatePayloadSha256: 'd'.repeat(64),
    profiles: [
      {
        id: 'win11-lab-1080p',
        candidatePayloadSha256: 'd'.repeat(64),
        scope: context(),
        evidence: {
          runCount: 3,
          reportPaths: ['one.json', 'two.json', 'three.json'],
          calibrationSha256: 'a'.repeat(64)
        },
        thresholds: {
          maximumTotalRssMiB: 2048,
          maximumTotalRssSlopeMiBPerMinute: 64,
          bmp: { maximumIntervalP95Ms: 200, minimumAdvancedFrames: 5 },
          roles: Object.fromEntries(
            ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg'].map(
              (role) => [role, roleThresholds]
            )
          )
        }
      }
    ]
  }
}

function passingMetrics() {
  const roleMemory = {
    maxRssKb: 128 * 1024,
    slopeRssKbPerMinute: 10 * 1024
  }
  const roleCpu = { averagePercent: 40, p95Percent: 60 }
  return {
    teardownClean: true,
    bmp: { advancedFrames: 10, intervalP95Ms: 100 },
    processTree: {
      memory: {
        summary: {
          maxTotalRssKb: 1024 * 1024,
          totalRss: { slopePerMinute: 16 * 1024 },
          roles: Object.fromEntries(
            ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg'].map(
              (role) => [role, roleMemory]
            )
          )
        }
      },
      cpu: {
        summary: {
          byRole: Object.fromEntries(
            ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg'].map(
              (role) => [role, roleCpu]
            )
          )
        }
      }
    }
  }
}

function comparisonBudgetDocument() {
  const document = budgetDocument()
  document.profiles[0].scope.operatingSystem.release = '10.0.26100'
  document.candidateSha256 = 'a'.repeat(64)
  document.comparison = {
    aggregatePath: 'comparison/aggregate.json',
    aggregateSha256: 'b'.repeat(64),
    reportPaths: Array.from({ length: 6 }, (_, index) => `comparison/run-${index + 1}.json`),
    reportSha256: Array.from({ length: 6 }, (_, index) =>
      String(index + 1)
        .repeat(64)
        .slice(0, 64)
    )
  }
  document.reviewedBy = 'Release reviewer'
  document.reviewedAt = '2026-07-29T12:00:00.000Z'
  const profile = document.profiles[0]
  profile.candidateSha256 = document.candidateSha256
  profile.evidence.reportSha256 = ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)]
  profile.evidence.calibrationPath = 'calibration/aggregate.json'
  profile.evidence.comparisonPaths = document.comparison.reportPaths
  profile.evidence.comparisonSha256 = document.comparison.reportSha256
  profile.thresholds.maximumTotalCpuP95Percent = 90
  profile.thresholds.gpu = {
    maximumEngineP95Percent: 80,
    maximumDedicatedMiB: 600,
    maximumSharedMiB: 200
  }
  profile.thresholds.bmp = {
    mode: 'disabled',
    maximumRequests: 0,
    maximumBytes: 0
  }
  return document
}
