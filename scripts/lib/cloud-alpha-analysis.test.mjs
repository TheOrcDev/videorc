import assert from 'node:assert/strict'
import test from 'node:test'
import { decideAlphaBudget, memoryTrend, percentile } from './cloud-alpha-analysis.mjs'

// Rule vectors only. These are not acquisition evidence and cannot approve transport.
const vector = () => ({
  durationMs: 1800000,
  frames: 50000,
  drops: 10,
  decodeSeconds: 20,
  bytes: 1e6,
  cpuSeconds: 100,
  rssBytes: 1e8,
  taskSeconds: 12,
  jsHeapBytes: 1e7,
  renderTicks: 50000,
  renderMissed: 10,
  latencyP95Ms: 100,
  latencyGrowthMs: 0,
  alphaError: 8,
  colorError: 12,
  startupMs: 1000,
  queuePeak: 1,
  contextLost: false,
  proxyOverflow: 0,
  proxyQueuePeak: 1024,
  memory: { growth: 0.01, monotonic: true },
  jsMemory: { growth: 0.01, monotonic: true },
  gpuTextureBytes: 2800000,
  gpuFrames: 50000,
  gpuDrawMs: 100,
  transportVerified: true,
  validClockFraction: 1,
  sampleCount: 1800
})
test('a passing rule vector never approves production or claims acquired evidence', () => {
  const answer = decideAlphaBudget(vector(), vector())
  assert.equal(answer.passed, true)
  assert.equal(answer.productionApproved, false)
})
test('missing/failed budgets cannot become feasibility approval', () => {
  for (const change of [
    { durationMs: 30000 },
    { decodeSeconds: null },
    { latencyP95Ms: null },
    { alphaError: 30 },
    { queuePeak: 2 },
    { transportVerified: false },
    { validClockFraction: 0.9 },
    { drops: 10000 },
    { memory: { growth: 0.11, monotonic: true } },
    { proxyOverflow: 1 },
    { contextLost: true },
    { gpuTextureBytes: undefined },
    { gpuFrames: undefined },
    { gpuDrawMs: NaN },
    { memory: { growth: NaN, monotonic: false } },
    { gpuTextureBytes: 4 * 1024 * 1024 },
    { jsMemory: undefined },
    { validClockFraction: undefined },
    { sampleCount: undefined },
    { proxyQueuePeak: undefined },
    { renderMissed: 10000 }
  ])
    assert.equal(decideAlphaBudget({ ...vector(), ...change }, vector()).passed, false)
})
test('memory trend and quantiles require real finite series', () => {
  assert.deepEqual(memoryTrend([]), { growth: null, monotonic: null })
  assert.equal(memoryTrend([100, 110, 120, 140]).monotonic, true)
  assert.ok(memoryTrend([100, 110, 120, 140]).growth > 0.1)
  assert.equal(percentile([1, NaN], 0.95), null)
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2)
})
