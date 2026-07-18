import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  evaluateWindowsPerformanceBudget,
  loadWindowsPerformanceBudget,
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
})

function context() {
  return {
    scenario: 'windows-proof-recording-1080p',
    hardwareClass: 'win11-x64-lab-a',
    profileClass: 'endurance',
    buildMode: 'packaged',
    operatingSystem: { platform: 'win32', arch: 'x64' },
    timing: { warmupMs: 60_000, measurementMs: 600_000, intervalMs: 1_000 }
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
    profiles: [
      {
        id: 'win11-lab-1080p',
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
