import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessYouTubeTrial, YouTubeTrialBudget } from './youtube-efficiency-probe.mjs'
import { summarizeYouTubeAttempts, youtubeAttemptCost } from './fake-youtube-api.mjs'

const now = Date.parse('2026-10-03T09:00:00Z')
const eligible = () => ({
  dailyLimit: 10000,
  usedUnits: 1000,
  sampledAt: new Date(now).toISOString(),
  measuredIngestionLagMs: 60000,
  knownSetupAndSendsUnits: 250,
  reservedTeardownUnits: 50,
  paidSends: 2,
  maximumOpens: 3,
  maximumSeconds: 60,
  ownerWindowConfirmed: true,
  privateOrUnlistedBroadcastConfirmed: true,
  attributionAvailable: true
})
test('preflight refuses exhausted, stale, unattributable and oversized live trials', () => {
  assert.equal(assessYouTubeTrial(eligible(), now).eligible, true)
  for (const patch of [
    { usedUnits: 10007 },
    { sampledAt: new Date(now - 600001).toISOString() },
    { measuredIngestionLagMs: null },
    { attributionAvailable: false },
    { maximumSeconds: 61 },
    { maximumOpens: 4 },
    { paidSends: 3 },
    { knownSetupAndSendsUnits: 451 },
    { reservedTeardownUnits: 0 }
  ]) {
    assert.equal(assessYouTubeTrial({ ...eligible(), ...patch }, now).eligible, false)
  }
  assert.equal(
    assessYouTubeTrial({ ...eligible(), token: 'do-not-echo' }, now).streamingEstimatedUnits,
    null
  )
  assert.doesNotMatch(
    JSON.stringify(assessYouTubeTrial({ token: 'do-not-echo' }, now)),
    /do-not-echo/
  )
})
test('trial ledger reserves teardown and bounds sends, opens and duration', () => {
  const budget = new YouTubeTrialBudget(assessYouTubeTrial(eligible(), now), now)
  budget.reserve({ units: 50, send: true, open: true }, now)
  budget.reserve({ units: 50, send: true, open: true }, now)
  assert.throws(() => budget.reserve({ units: 50, send: true }, now), /send/)
  budget.reserve({ units: 150, open: true }, now)
  assert.throws(() => budget.reserve({ units: 1 }, now), /budget/)
  assert.throws(() => budget.reserve({ units: 0, open: true }, now), /open/)
  assert.throws(() => budget.reserve({ units: null }, now), /Unknown/)
  assert.throws(() => budget.reserve({ units: 0 }, now + 60000), /deadline/)
})
test('wire summaries count retries, rejections and deletes, exclude OAuth, and retain unknown cost', () => {
  const result = summarizeYouTubeAttempts([
    { method: 'POST', path: '/token', status: 200 },
    { method: 'POST', path: '/youtube/v3/liveChat/messages', status: 401 },
    { method: 'POST', path: '/youtube/v3/liveChat/messages', status: 200 },
    { method: 'DELETE', path: '/youtube/v3/liveBroadcasts', status: 403 },
    { method: 'GET', path: '/youtube/v3/channels', status: 200 },
    { method: 'GET', path: '/youtube/v3/liveChat/messages/stream', status: 200 }
  ])
  assert.equal(result.calls, 5)
  assert.equal(result.estimatedUnits, 151)
  assert.equal(result.unknown, 1)
  assert.deepEqual(result.endpoints['liveChatMessages.insert'].outcomes, { 401: 1, 200: 1 })
  assert.deepEqual(youtubeAttemptCost('PUT', '/youtube/v3/liveBroadcasts'), {
    endpoint: 'liveBroadcasts.update',
    units: 50
  })
})

test('non-default teardown stays reserved and refused reservations never mutate counters', () => {
  const budget = new YouTubeTrialBudget(
    assessYouTubeTrial({ ...eligible(), reservedTeardownUnits: 200 }, now),
    now
  )
  budget.reserve({ units: 250, open: true }, now)
  const before = { knownUnits: budget.knownUnits, opens: budget.opens, sends: budget.sends }
  assert.throws(() => budget.reserve({ units: 1, open: true, send: true }, now), /budget/)
  assert.deepEqual(
    { knownUnits: budget.knownUnits, opens: budget.opens, sends: budget.sends },
    before
  )
})
