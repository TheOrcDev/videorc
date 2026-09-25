import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  COHOST_SPOTLIGHT_PATH,
  COHOST_SPOTLIGHT_REQUEST_KEYS,
  COHOST_TICK_REQUEST_KEYS,
  askerLabel,
  normalizeQuestionText,
  planCohostSpotlight,
  planCohostTick,
  planTickHighlights,
  startFakeCohostService,
  validateCohostSpotlightRequest,
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
      validateCohostTickRequest(tickBody({ promptVersion: 3 })).code,
      'prompt-version-unsupported'
    )
    // v2 = v1 plus the optional, already-normalised `rules`.
    assert.equal(validateCohostTickRequest(tickBody({ promptVersion: 2 })), null)
    assert.equal(
      validateCohostTickRequest(tickBody({ promptVersion: 2, rules: ['No spoilers'] })),
      null
    )
    assert.equal(
      validateCohostTickRequest(tickBody({ promptVersion: 2, rules: [' padded '] })).code,
      'invalid-request'
    )
    assert.equal(
      validateCohostTickRequest(tickBody({ promptVersion: 2, rules: Array(11).fill('r') })).code,
      'invalid-request'
    )
    assert.equal(
      validateCohostTickRequest(tickBody({ promptVersion: 1, rules: [] })).code,
      'invalid-request'
    )
    assert.equal(validateCohostTickRequest(tickBody({ extra: 1 })).code, 'invalid-request')
    assert.equal(
      validateCohostTickRequest(tickBody({ messages: [{ ...message('a', 0), bogus: true }] })).code,
      'invalid-request'
    )
    assert.deepEqual(Object.keys(tickBody()).sort(), [...COHOST_TICK_REQUEST_KEYS])
  })
})

function spotlightCandidate(seq, overrides = {}) {
  return {
    id: `smoke-session:twitch:lane-a:fake-${seq}`,
    text: `Fake chat message #${seq}`,
    author: `Test Viewer ${seq % 3}`,
    at: '2026-08-22T10:00:00Z',
    ...overrides
  }
}

function spotlightBody(overrides = {}) {
  return {
    clientVersion: 'videorc-desktop/0.0.0-test',
    sessionClientId: 'smoke-session',
    consentToProcessChat: true,
    transcript: 'yeah so about the keyboard, it is a keychron',
    seq: 1,
    candidates: [
      spotlightCandidate(0, { questionId: 'q_1', questionText: 'What keyboard is that?' }),
      spotlightCandidate(1)
    ],
    ...overrides
  }
}

describe('fake co-host tick highlights', () => {
  it('suggests every message with the flagged one first, and nothing without a rule', () => {
    const batch = [message('lane-a', 0), message('lane-a', 1), message('lane-a', 2)]
    assert.equal(planTickHighlights(batch, null, '#2'), null)
    assert.deepEqual(planTickHighlights(batch, { score: 0.9, type: 'praise' }, '#2'), [
      { messageId: batch[2].id, score: 0.99, type: 'praise' },
      { messageId: batch[0].id, score: 0.9, type: 'praise' },
      { messageId: batch[1].id, score: 0.89, type: 'praise' }
    ])

    let next = 1
    const mintId = () => `q_${next++}`
    const plain = planCohostTick(tickBody({ messages: batch }), { mintId, flagMarker: '#2' })
    assert.ok(!('highlights' in plain), 'no rule keeps the v1-shaped response')
    const scripted = planCohostTick(tickBody({ messages: batch }), {
      mintId,
      flagMarker: '#2',
      highlights: { score: 0.8 }
    })
    assert.deepEqual(
      scripted.highlights.map((highlight) => [highlight.messageId, highlight.type]),
      [
        [batch[2].id, 'insight'],
        [batch[0].id, 'insight'],
        [batch[1].id, 'insight']
      ]
    )
    assert.deepEqual(
      scripted.flags.map((flag) => flag.messageId),
      [batch[2].id]
    )
  })
})

describe('fake co-host spotlight planner', () => {
  it('scripts matches on transcript substrings and echoes question fields only for question candidates', () => {
    const rules = [
      {
        whenTranscriptIncludes: 'KEYBOARD',
        messageId: 'smoke-session:twitch:lane-a:fake-0',
        about: 0.9,
        questionId: 'q_1',
        answered: 0.85
      },
      {
        whenTranscriptIncludes: 'message #1',
        messageId: 'smoke-session:twitch:lane-a:fake-1',
        about: 1
      },
      {
        whenTranscriptIncludes: 'never said',
        messageId: 'smoke-session:twitch:lane-a:fake-0',
        about: 1
      }
    ]
    const planned = planCohostSpotlight(spotlightBody(), rules)
    assert.equal(planned.seq, 1)
    assert.deepEqual(planned.matches, [
      {
        messageId: 'smoke-session:twitch:lane-a:fake-0',
        about: 0.9,
        questionId: 'q_1',
        answered: 0.85
      },
      { messageId: 'smoke-session:twitch:lane-a:fake-1', about: 0 }
    ])
    assert.equal(planned.usage.model, 'smoke/fake-cohost-spotlight')

    // A rule for another question id never reports "answered" for this one;
    // a silent transcript yields zeros, never a missing candidate.
    const other = planCohostSpotlight(spotlightBody({ transcript: 'nothing to see' }), [
      {
        whenTranscriptIncludes: 'nothing',
        messageId: 'smoke-session:twitch:lane-a:fake-0',
        about: 2,
        questionId: 'q_9',
        answered: 1
      }
    ])
    assert.deepEqual(other.matches[0], {
      messageId: 'smoke-session:twitch:lane-a:fake-0',
      about: 1,
      questionId: 'q_1',
      answered: 0
    })
  })

  it('rejects spotlight contract violations with the documented codes', () => {
    assert.equal(validateCohostSpotlightRequest(spotlightBody()), null)
    assert.equal(
      validateCohostSpotlightRequest(spotlightBody({ consentToProcessChat: false })).code,
      'consent-required'
    )
    assert.equal(
      validateCohostSpotlightRequest(spotlightBody({ extra: 1 })).code,
      'invalid-request'
    )
    assert.equal(
      validateCohostSpotlightRequest(spotlightBody({ transcript: '   ' })).code,
      'invalid-request'
    )
    assert.equal(
      validateCohostSpotlightRequest(spotlightBody({ transcript: 'x'.repeat(801) })).code,
      'invalid-request'
    )
    assert.equal(
      validateCohostSpotlightRequest(spotlightBody({ candidates: [] })).code,
      'invalid-request'
    )
    assert.equal(
      validateCohostSpotlightRequest(
        spotlightBody({
          candidates: Array.from({ length: 21 }, (_, seq) => spotlightCandidate(seq))
        })
      ).code,
      'invalid-request'
    )
    assert.equal(
      validateCohostSpotlightRequest(
        spotlightBody({ candidates: [spotlightCandidate(0), spotlightCandidate(0)] })
      ).code,
      'invalid-request'
    )
    assert.equal(
      validateCohostSpotlightRequest(
        spotlightBody({ candidates: [spotlightCandidate(0, { bogus: true })] })
      ).code,
      'invalid-request'
    )
    assert.equal(
      validateCohostSpotlightRequest(
        spotlightBody({ candidates: [spotlightCandidate(0, { questionId: 'q'.repeat(81) })] })
      ).code,
      'invalid-request'
    )
    assert.equal(validateCohostSpotlightRequest(spotlightBody({ seq: -1 })).code, 'invalid-request')
    assert.deepEqual(Object.keys(spotlightBody()).sort(), [...COHOST_SPOTLIGHT_REQUEST_KEYS])
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

  it('serves scripted tick highlights and records the suggested ids', async () => {
    const fake = await startFakeCohostService({ smokeSessionToken: sessionToken, flagMarker: '#2' })
    const post = (body) =>
      fetch(`${fake.httpOrigin}/api/ai/cohost/tick`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    try {
      const batch = [message('lane-a', 1), message('lane-a', 2)]
      const before = await (await post(tickBody({ messages: batch }))).json()
      assert.ok(!('highlights' in before))
      assert.equal(fake.state.requests[0].highlightIds, undefined)

      fake.setTickHighlights({ score: 0.7 })
      const after = await (await post(tickBody({ tickSeq: 2, messages: batch }))).json()
      assert.deepEqual(
        after.highlights.map((highlight) => highlight.messageId),
        [batch[1].id, batch[0].id]
      )
      assert.deepEqual(fake.state.requests[1].highlightIds, [batch[1].id, batch[0].id])
      assert.throws(() => fake.setTickHighlights([]), /rule object or null/)
    } finally {
      await fake.close()
    }
  })

  it('serves the spotlight route on the same origin with scripted matches, failures and the byte budget', async () => {
    const fake = await startFakeCohostService({
      smokeSessionToken: sessionToken,
      spotlightMatches: [
        {
          whenTranscriptIncludes: 'keyboard',
          messageId: 'smoke-session:twitch:lane-a:fake-0',
          about: 0.9,
          questionId: 'q_1',
          answered: 0.85
        }
      ]
    })
    const post = (body, token = sessionToken) =>
      fetch(`${fake.httpOrigin}${COHOST_SPOTLIGHT_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      })
    try {
      const unauthorized = await post(spotlightBody(), 'wrong-token')
      assert.equal(unauthorized.status, 401)
      assert.equal(fake.state.spotlightRequests.length, 0)

      const ok = await post(spotlightBody())
      assert.equal(ok.status, 200)
      const planned = await ok.json()
      assert.equal(planned.seq, 1)
      assert.equal(planned.matches[0].about, 0.9)
      assert.equal(planned.matches[0].answered, 0.85)
      // Tick records never see spotlight traffic.
      assert.equal(fake.state.requests.length, 0)
      assert.equal(fake.state.spotlightRequests.length, 1)
      assert.equal(fake.state.spotlightRequests[0].body.seq, 1)

      fake.setSpotlightMatches([])
      const silent = await (await post(spotlightBody({ seq: 2 }))).json()
      assert.deepEqual(
        silent.matches.map((match) => match.about),
        [0, 0]
      )

      fake.queueSpotlightFailure({ status: 503, code: 'spotlight-disabled' })
      fake.queueSpotlightFailure({ status: 429, code: 'quota-exhausted', retryAfterSeconds: 7 })
      fake.queueSpotlightFailure({ status: 404 })
      const disabled = await post(spotlightBody({ seq: 3 }))
      assert.equal(disabled.status, 503)
      assert.equal((await disabled.json()).error.code, 'spotlight-disabled')
      const quota = await post(spotlightBody({ seq: 4 }))
      assert.equal(quota.status, 429)
      assert.equal(quota.headers.get('retry-after'), '7')
      const missing = await post(spotlightBody({ seq: 5 }))
      assert.equal(missing.status, 404)

      const consent = await post(spotlightBody({ seq: 6, consentToProcessChat: false }))
      assert.equal(consent.status, 400)
      assert.equal((await consent.json()).error.code, 'consent-required')

      // The 32 KB budget is checked on the raw body like the real route.
      const huge = spotlightBody({
        seq: 7,
        candidates: Array.from({ length: 20 }, (_, seq) =>
          spotlightCandidate(seq, { text: 'x'.repeat(500), author: 'y'.repeat(120) })
        ),
        transcript: 'z'.repeat(800)
      })
      const hugeBody = JSON.stringify(huge) + ' '.repeat(32 * 1024)
      const tooBig = await post(hugeBody)
      assert.equal(tooBig.status, 400)
      assert.equal((await tooBig.json()).error.code, 'invalid-request')

      assert.deepEqual(
        fake.state.spotlightRequests.map((record) => [record.status, record.code]),
        [
          [200, null],
          [200, null],
          [503, 'spotlight-disabled'],
          [429, 'quota-exhausted'],
          [404, null],
          [400, 'consent-required'],
          [400, 'invalid-request']
        ]
      )
      assert.equal(fake.state.unknownRoutes, 0)
      assert.equal(fake.state.unauthorized, 1)
    } finally {
      await fake.close()
    }
  })
})
