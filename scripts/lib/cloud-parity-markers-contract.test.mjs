import test from 'node:test'
import assert from 'node:assert/strict'
import { assessMarkers } from './cloud-parity-markers-contract.mjs'
const mark = (seconds, interval = null) => ({
  showId: 'sh_one',
  atSeconds: seconds,
  createdAt: new Date(Date.UTC(2026, 10, 17, 12, 0, seconds)).toISOString(),
  time: {
    origin: '2026-11-17T12:00:00.000Z',
    basis: 'server-show-created-at',
    observation: 'server-accepted',
    mediaUncertaintyMs: null
  },
  target: { liveIntervalId: interval, takeIds: ['tk_one'] },
  media: { extractable: false }
})
const fixture = () => {
  const first = mark(1),
    afterReconnect = mark(2),
    recordOnly = mark(3),
    live = mark(4, 'interval1'),
    ended = mark(5),
    next = mark(6, 'interval2'),
    afterHandoff = mark(7)
  return {
    first,
    afterReconnect,
    recordOnly,
    live,
    ended,
    next,
    afterHandoff,
    marks: [first, afterReconnect, recordOnly, live, ended, next, afterHandoff]
  }
}
test('analyzer distinguishes local fixture behavior from managed/media qualification', () => {
  assert.deepEqual(assessMarkers(fixture()), {
    status: 'passed-local-fixture',
    productionQualified: false,
    managed: 'not-run',
    mediaAlignment: 'unavailable'
  })
})
test('analyzer refuses rebased show origins, fabricated file identity or invented certainty', () => {
  for (const mutate of [
    (r) => (r.next.time.origin = 'now'),
    (r) => (r.first.sessionId = 'fake'),
    (r) => (r.first.time.mediaUncertaintyMs = 0),
    (r) => (r.next.target.liveIntervalId = 'interval1'),
    (r) => (r.first.media.extractable = true)
  ]) {
    const r = fixture()
    mutate(r)
    assert.throws(() => assessMarkers(r))
  }
})
