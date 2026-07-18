import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parsePerformanceBudgetPreflightArgs,
  performanceBudgetPreflightContext
} from '../performance-budget-preflight.mjs'

describe('performance budget preflight CLI', () => {
  it('requires and preserves exact short-sentinel timing identity', () => {
    assert.deepEqual(
      parsePerformanceBudgetPreflightArgs([
        '--scenario',
        'detached-native-preview',
        '--artifact-only',
        '--profile-class',
        'short-sentinel',
        '--warmup-seconds',
        '60',
        '--measurement-seconds',
        '120',
        '--sample-interval-ms',
        '1000'
      ]),
      {
        artifactOnly: true,
        scenario: 'detached-native-preview',
        profileClass: 'short-sentinel',
        warmupMs: 60_000,
        measurementMs: 120_000,
        intervalMs: 1_000
      }
    )
  })

  it('rejects profile classes whose measurement windows overlap', () => {
    assert.throws(
      () =>
        parsePerformanceBudgetPreflightArgs([
          '--scenario=detached-native-preview',
          '--profile-class=endurance',
          '--warmup-seconds=60',
          '--measurement-seconds=120',
          '--sample-interval-ms=1000'
        ]),
      /at least 600 measurement seconds/
    )
  })

  it('binds the packaged payload while leaving commit and launcher hashes as provenance', () => {
    const context = performanceBudgetPreflightContext({
      scenario: 'detached-native-preview',
      metadata: {
        profileClass: 'short-sentinel',
        appVersion: '0.9.45',
        machineModel: 'Mac16,1',
        hardwareClass: null,
        buildMode: 'packaged',
        commit: 'a'.repeat(40),
        executable: { sha256: 'b'.repeat(64) },
        packagePayload: { sha256: 'c'.repeat(64) },
        operatingSystem: { platform: 'darwin', arch: 'arm64' }
      },
      timing: { warmupMs: 60_000, measurementMs: 120_000, intervalMs: 1_000 }
    })

    assert.equal(context.packagePayloadSha256, 'c'.repeat(64))
    assert.equal('commit' in context, false)
    assert.equal('executableSha256' in context, false)
  })
})
