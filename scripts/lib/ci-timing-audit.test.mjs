import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  blacksmithMonthlyCost,
  bucketJob,
  isSetupStep,
  monthlyMinutesByOs,
  percentile,
  runWallSeconds,
  summarizeJobs
} from './ci-timing-audit.mjs'

const t = (seconds) => new Date(Date.UTC(2026, 10, 16, 0, 0, seconds)).toISOString()

function job(overrides = {}) {
  return {
    name: 'Rust (test + clippy + fmt)',
    status: 'completed',
    conclusion: 'success',
    labels: ['macos-15'],
    created_at: t(0),
    started_at: t(10),
    completed_at: t(110),
    steps: [
      { name: 'Set up job', started_at: t(10), completed_at: t(12) },
      { name: 'Check out repository', started_at: t(12), completed_at: t(20) },
      { name: 'Clippy', started_at: t(20), completed_at: t(100) },
      { name: 'Complete job', started_at: t(100), completed_at: t(110) }
    ],
    ...overrides
  }
}

describe('ci-timing-audit', () => {
  it('splits a job into waiting, setup and running', () => {
    assert.deepEqual(bucketJob(job()), {
      name: 'Rust (test + clippy + fmt)',
      os: 'macos',
      waiting: 10,
      setup: 20,
      running: 80,
      total: 100,
      conclusion: 'success'
    })
  })

  it('ignores skipped and cancelled jobs', () => {
    assert.equal(bucketJob(job({ conclusion: 'skipped' })), null)
    assert.equal(bucketJob(job({ conclusion: 'cancelled' })), null)
    assert.equal(bucketJob(job({ status: 'in_progress' })), null)
  })

  it('treats checks as running, not setup', () => {
    assert.equal(isSetupStep('Clippy'), false)
    assert.equal(isSetupStep('Desktop tests'), false)
    assert.equal(isSetupStep('Install dependencies'), true)
    assert.equal(isSetupStep('Run Swatinem/rust-cache@v2'), true)
  })

  it('keeps a skip twin apart from the gate it shares a name with', () => {
    const real = bucketJob(job())
    const twin = bucketJob(job({ labels: ['ubuntu-latest'], completed_at: t(13), steps: [] }))
    const rows = summarizeJobs([
      { workflow: 'ci.yml', bucket: real },
      { workflow: 'ci.yml', bucket: twin }
    ])
    assert.deepEqual(
      rows.map((row) => [row.key, row.count]),
      [
        ['ci.yml / Rust (test + clippy + fmt) [macos]', 1],
        ['ci.yml / Rust (test + clippy + fmt) [linux]', 1]
      ]
    )
  })

  it('uses nearest-rank percentiles', () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3)
    assert.equal(percentile([5, 1, 3, 2, 4], 95), 5)
    assert.equal(percentile([], 50), null)
  })

  it('measures a re-run from its own attempt, not the first one', () => {
    const run = { created_at: t(0), run_started_at: t(500) }
    assert.equal(runWallSeconds(run, [job({ started_at: t(510), completed_at: t(600) })]), 100)
  })

  it('extrapolates runner minutes to 30 days and prices them', () => {
    const minutes = monthlyMinutesByOs([bucketJob(job())], 3)
    assert.equal(minutes.macos, Math.round((100 / 60) * 10))
    assert.equal(blacksmithMonthlyCost({ linux: 0, windows: 0, macos: 3000 }), 0)
    assert.equal(blacksmithMonthlyCost({ linux: 1000, windows: 0, macos: 3000 }), 4)
  })
})
