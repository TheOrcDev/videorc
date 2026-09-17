import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { syntheticCompositorReady } from './remote-control-smoke-gates.mjs'

const smoke = readFileSync(join(process.cwd(), 'scripts', 'smoke-remote-control-app.mjs'), 'utf8')

test('remote-control scene proof establishes a deterministic backend-rendered source', () => {
  assert.match(smoke, /VIDEORC_SMOKE_PREVIEW_MOTION: '1'/)
  assert.match(smoke, /requestSmokeCommand/)
  assert.match(smoke, /'enable-synthetic-source'/)
  assert.match(smoke, /'compositor\.status'/)
  assert.match(smoke, /syntheticCompositorReady/)
  assert.doesNotMatch(smoke, /'preview\.screen\.status'/)
  assert.ok(
    smoke.indexOf("'enable-synthetic-source'") < smoke.indexOf("kind: 'sceneApply'"),
    'the synthetic source must be armed before the remote scene intent'
  )
})

test('synthetic compositor proof rejects stale frames and accepts the rendered revision', () => {
  const before = { runId: 'run-a', framesRendered: 10 }
  const candidate = {
    state: 'live',
    runId: 'run-a',
    framesRendered: 11,
    sceneRevision: 8,
    frameSceneRevision: 7,
    sceneSources: [{ id: 'source:test-pattern', kind: 'test-pattern' }]
  }
  assert.equal(syntheticCompositorReady({ ...candidate, framesRendered: 10 }, before), false)
  assert.equal(syntheticCompositorReady(candidate, before), false)
  assert.equal(
    syntheticCompositorReady({ ...candidate, frameSceneRevision: candidate.sceneRevision }, before),
    true
  )
  assert.equal(
    syntheticCompositorReady(
      {
        ...candidate,
        runId: 'run-b',
        framesRendered: 1,
        frameSceneRevision: candidate.sceneRevision
      },
      before
    ),
    true,
    'a replacement compositor proves advancement within its new run'
  )
})

test('remote-control intent proof correlates acknowledgements to exact tickets', () => {
  assert.match(smoke, /micAck\?\.intentId !== micTicket\.payload\.intentId/)
  assert.match(smoke, /sceneAck\?\.intentId !== sceneTicket\.payload\.intentId/)
  assert.match(smoke, /micAck\?\.ok !== true/)
  assert.match(smoke, /sceneAck\?\.ok !== true/)
})
