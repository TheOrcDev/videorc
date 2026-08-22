import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  COHOST_TICK_REQUEST_KEYS,
  askerLabel,
  normalizeQuestionText,
  planCohostTick,
  startFakeCohostService,
  validateCohostTickRequest
} from './fake-cohost-service.mjs'

const sessionToken = 'fake-cohost-session-token'

function message(target, seq, { platform = 'twitch', author = `Test Viewer ${seq % 3}` } = {}) {
  return {
    id: `smoke-session:${platform}:${target}:fake-${seq}`,
    platform,
    author,
    text: `Fake chat message #${seq}`,
    at: '2026-08-22T10:00:00Z'
  }
}

function tickBody(overrides = {}) {
  return {
    clientVersion: 'videorc-desktop/0.0.0-test',
    sessionClientId: 'smoke-session',
    tickSeq: 1,
    promptVersion: 1,
    consentToProcessChat: true,
    tone: 'short',
    notes: '',
    streamTitle: null,
    openQuestions: [],
    messages: [],
    droppedMessages: 0,
    ...overrides
  }
}

describe('fake co-host planner', () => {
  it('normalizes question text and keys askers on author plus destination', () => {
    assert.equal(normalizeQuestionText('  What KEYBOARD?? '), 'what keyboard')
    assert.equal(normalizeQuestionText('same   words.'), 'same words')
    assert.equal(askerLabel(message('lane-a', 0)), 'Test Viewer 0@lane-a')
    assert.equal(askerLabel({ id: 'no-destination', author: 'x' }), 'x@unknown')
  })

  it('groups repeated text into one question, keeps echoed ids, and unions askers across ticks', () => {
    let next = 1
    const mintId = () => `q_${next++}`
    const memory = new Map()
    const first = planCohostTick(
      tickBody({
        messages: [message('lane-a', 0), message('lane-a', 1), message('lane-b', 0)]
      }),
      { mintId, memory }
    )
    assert.deepEqual(
      first.questions.map((question) => [question.id, question.text, question.askers.length]),
      [
        ['q_1', 'Fake chat message #0', 2],
        ['q_2', 'Fake chat message #1', 1]
      ]
    )
    assert.deepEqual(first.questions[0].messageIds, [
      'smoke-session:twitch:lane-a:fake-0',
      'smoke-session:twitch:lane-b:fake-0'
    ])
    assert.equal(first.questions[0].priority, 'normal')
    assert.equal(first.questions[0].suggestedReply, 'Re: Fake chat message #0')
    assert.equal(first.mood, 'calm')

    // The desktop echoes the open set (id/text/count) and sends only the delta:
    // the same text must keep q_1 and the asker union must grow to three.
    const second = planCohostTick(
      tickBody({
        tickSeq: 2,
        openQuestions: first.questions.map((question) => ({
          id: question.id,
          text: question.text,
          count: question.askers.length
        })),
        messages: [message('lane-c', 0, { platform: 'youtube' }), message('lane-a', 2)]
      }),
      { mintId, memory }
    )
    const grouped = second.questions.find((question) => question.id === 'q_1')
    assert.equal(grouped.askers.length, 3)
    assert.deepEqual(grouped.platforms, ['twitch', 'youtube'])
    assert.equal(grouped.priority, 'high')
    assert.deepEqual(grouped.messageIds, ['smoke-session:youtube:lane-c:fake-0'])
    assert.ok(second.questions.some((question) => question.id === 'q_2'))
    assert.equal(second.questions.find((question) => question.text.endsWith('#2')).id, 'q_3')
    assert.deepEqual(second.resolved, [])
  })

  it('flags only messages carrying the exact marker token', () => {
    const planned = planCohostTick(
      tickBody({
        messages: [message('lane-a', 2), message('lane-a', 20), message('lane-a', 12)]
      }),
      { mintId: () => 'q_x', flagMarker: '#2' }
    )
    assert.deepEqual(
      planned.flags.map((flag) => flag.messageId),
      ['smoke-session:twitch:lane-a:fake-2']
    )
    assert.equal(planned.flags[0].kind, 'spam')
    assert.equal(planned.flags[0].severity, 'medium')
  })

  it('rejects contract violations with the documented codes', () => {
    assert.equal(validateCohostTickRequest(tickBody()), null)
    assert.equal(
      validateCohostTickRequest(tickBody({ consentToProcessChat: false })).code,
      'consent-required'
    )
    assert.equal(
      validateCohostTickRequest(tickBody({ promptVersion: 2 })).code,
      'prompt-version-unsupported'
    )
    assert.equal(validateCohostTickRequest(tickBody({ extra: 1 })).code, 'invalid-request')
    assert.equal(
      validateCohostTickRequest(tickBody({ messages: [{ ...message('a', 0), bogus: true }] })).code,
      'invalid-request'
    )
    assert.deepEqual(Object.keys(tickBody()).sort(), [...COHOST_TICK_REQUEST_KEYS])
  })
})

describe('fake co-host service', () => {
  it('authenticates, records requests, and serves scripted error modes', async () => {
    const fake = await startFakeCohostService({ smokeSessionToken: sessionToken, flagMarker: '#2' })
    const post = (body, token = sessionToken) =>
      fetch(`${fake.httpOrigin}/api/ai/cohost/tick`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    try {
      const unauthorized = await post(tickBody(), 'wrong-token')
      assert.equal(unauthorized.status, 401)
      assert.equal((await unauthorized.json()).error.code, 'unauthorized')
      assert.equal(fake.state.requests.length, 0)

      const ok = await post(tickBody({ messages: [message('lane-a', 0), message('lane-a', 2)] }))
      assert.equal(ok.status, 200)
      const planned = await ok.json()
      assert.equal(planned.promptVersion, 1)
      assert.equal(planned.questions.length, 2)
      assert.equal(planned.flags.length, 1)
      assert.equal(planned.usage.model, 'smoke/fake-cohost')

      fake.queueFailure({ status: 429, code: 'quota-exhausted', retryAfterSeconds: 12 })
      const quota = await post(tickBody({ tickSeq: 2, messages: [message('lane-a', 3)] }))
      assert.equal(quota.status, 429)
      assert.equal(quota.headers.get('retry-after'), '12')
      assert.equal((await quota.json()).error.code, 'quota-exhausted')

      fake.queueFailure({ status: 403, code: 'premium-required' })
      fake.queueFailure({ status: 503, code: 'cohost-disabled' })
      const premium = await post(tickBody({ tickSeq: 3, messages: [message('lane-a', 4)] }))
      assert.equal(premium.status, 403)
      assert.equal((await premium.json()).error.code, 'premium-required')
      const disabled = await post(tickBody({ tickSeq: 4, messages: [message('lane-a', 5)] }))
      assert.equal(disabled.status, 503)
      assert.equal((await disabled.json()).error.code, 'cohost-disabled')

      const consent = await post(tickBody({ tickSeq: 5, consentToProcessChat: false }))
      assert.equal(consent.status, 400)
      assert.equal((await consent.json()).error.code, 'consent-required')

      const unknown = await fetch(`${fake.httpOrigin}/api/ai/capabilities`, {
        headers: { authorization: `Bearer ${sessionToken}` }
      })
      assert.equal(unknown.status, 404)
      assert.equal(fake.state.unknownRoutes, 1)

      assert.deepEqual(
        fake.state.requests.map((record) => [record.body.tickSeq, record.status, record.code]),
        [
          [1, 200, null],
          [2, 429, 'quota-exhausted'],
          [3, 403, 'premium-required'],
          [4, 503, 'cohost-disabled'],
          [5, 400, 'consent-required']
        ]
      )
      assert.equal(fake.state.unauthorized, 1)
    } finally {
      await fake.close()
    }
  })
})
