import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPreviewGate,
  PreviewLatencyGateBreach,
  reportPreviewGateFailure
} from './native-preview-failure-policy.mjs'

test('a diagnostic latency breach keeps its identity through the statistics gate', () => {
  const problem = new PreviewLatencyGateBreach('p95 452ms exceeds 350ms')
  const originalStack = problem.stack
  assert.throws(
    () =>
      assertPreviewGate(() => {
        throw problem
      }),
    (caught) => {
      assert.equal(caught, problem)
      assert.ok(caught instanceof PreviewLatencyGateBreach)
      assert.equal(caught.retryable, true)
      assert.equal(caught.stack, originalStack)
      assert.equal(caught.message, 'p95 452ms exceeds 350ms')
      return true
    }
  )
})

test('non-latency and combined failures stay fatal with their original evidence', () => {
  const latency = new PreviewLatencyGateBreach('p99 exceeds budget')
  const stop = new Error('recording could not stop')
  const problems = [
    new Error('artifact failed', { cause: stop }),
    new AggregateError([latency, stop], 'scenario and stop failed')
  ]
  for (const problem of problems) {
    assert.throws(
      () =>
        assertPreviewGate(() => {
          throw problem
        }),
      (caught) => {
        assert.equal(caught, problem)
        assert.equal(caught instanceof PreviewLatencyGateBreach, false)
        return true
      }
    )
  }
})

test('direct and statistics latency failures use the same retry classification', () => {
  const problem = new PreviewLatencyGateBreach('p99 525ms exceeds 500ms')
  for (const report of [
    () => reportPreviewGateFailure(problem),
    () => assertPreviewGate(() => reportPreviewGateFailure(problem))
  ]) {
    assert.throws(report, (caught) => caught === problem)
  }
})

test('text failures remain errors without gaining retry eligibility', () => {
  assert.throws(
    () => reportPreviewGateFailure('missing preview evidence'),
    (caught) => {
      assert.ok(caught instanceof Error)
      assert.equal(caught instanceof PreviewLatencyGateBreach, false)
      assert.equal(caught.message, 'missing preview evidence')
      return true
    }
  )
})

test('explicit report-only mode warns without changing the original failure', () => {
  const warnings = []
  const problem = new PreviewLatencyGateBreach('p95 exceeds budget')
  const result = assertPreviewGate(
    () => {
      throw problem
    },
    { reportOnly: true, warn: (message) => warnings.push(message) }
  )
  assert.equal(result, undefined)
  assert.deepEqual(warnings, ['[report-only] p95 exceeds budget'])
  assert.equal(problem.message, 'p95 exceeds budget')
  assert.throws(
    () => reportPreviewGateFailure(problem),
    (caught) => caught === problem
  )
})

test('a passing check returns its result without warnings', () => {
  const result = { measured: true }
  assert.equal(
    assertPreviewGate(() => result, {
      warn: () => assert.fail('a passing gate must not warn')
    }),
    result
  )
})
