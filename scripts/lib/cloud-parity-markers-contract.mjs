import assert from 'node:assert/strict'
/** Only analyzes acquired receipts; it cannot qualify media alignment. */
export function assessMarkers(r) {
  assert.ok(r.marks.length >= 7)
  const origin = r.first.time.origin,
    show = r.first.showId
  for (const m of r.marks) {
    assert.equal(m.showId, show)
    assert.equal(m.time.origin, origin)
    assert.equal(m.time.basis, 'server-show-created-at')
    assert.equal(m.time.observation, 'server-accepted')
    assert.equal(m.time.mediaUncertaintyMs, null)
    assert.equal(m.media.extractable, false)
    assert.ok(!('sessionId' in m))
    assert.equal(m.atSeconds, (Date.parse(m.createdAt) - Date.parse(origin)) / 1000)
  }
  assert.ok(r.afterReconnect.atSeconds >= r.first.atSeconds)
  assert.equal(r.recordOnly.target.liveIntervalId, null)
  assert.equal(r.ended.target.liveIntervalId, null)
  assert.ok(r.live.target.liveIntervalId)
  assert.ok(r.next.target.liveIntervalId)
  assert.notEqual(r.live.target.liveIntervalId, r.next.target.liveIntervalId)
  assert.deepEqual(r.recordOnly.target.takeIds, r.next.target.takeIds)
  assert.equal(r.afterHandoff.showId, show)
  return {
    status: 'passed-local-fixture',
    productionQualified: false,
    managed: 'not-run',
    mediaAlignment: 'unavailable'
  }
}
