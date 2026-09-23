import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startScheduledStreamsFixture } from './scheduled-streams-fixture.mjs'

test('scheduled fixture requires its local token and never advances events with the clock', async () => {
  const fixture = await startScheduledStreamsFixture()
  try {
    assert.equal((await fetch(`${fixture.origin}/youtube/v3/liveBroadcasts`)).status, 401)
    const created = await fetch(`${fixture.origin}/youtube/v3/liveBroadcasts`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-fixture-only', 'content-type': 'application/json' },
      body: JSON.stringify({
        snippet: { title: 'Past time', scheduledStartTime: '2000-01-01T00:00:00Z' },
        status: { privacyStatus: 'private' },
        contentDetails: { enableAutoStart: false }
      })
    }).then((response) => response.json())
    assert.equal(created.status.lifeCycleStatus, 'ready')
    assert.equal(fixture.streams.size, 0)
    assert.equal(fixture.calls.filter((call) => call.path.endsWith('/transition')).length, 0)
  } finally {
    await fixture.close()
  }
})

test('X routes need an OAuth signature, refuse auto-publish go-live and open-ended updates', async () => {
  const fixture = await startScheduledStreamsFixture()
  const signed = {
    authorization: 'OAuth oauth_consumer_key="k", oauth_signature="s"',
    'content-type': 'application/json'
  }
  try {
    assert.equal((await fetch(`${fixture.origin}/2/broadcasts/scheduled`)).status, 401)
    const source = await fetch(`${fixture.origin}/2/users/1/sources`, {
      method: 'POST',
      headers: signed,
      body: JSON.stringify({ name: 'Videorc Scheduled 1', region: 'fixture-region' })
    }).then((response) => response.json())
    const created = await fetch(`${fixture.origin}/2/broadcasts/scheduled`, {
      method: 'POST',
      headers: signed,
      body: JSON.stringify({
        source_id: source.source.id,
        scheduled_start_ms: '2051265600000',
        scheduled_end_ms: '2051272800000',
        title: 'X',
        manual_publish: false
      })
    }).then((response) => response.json())
    assert.equal(created.data.state, 'Created')
    const auto = await fetch(
      `${fixture.origin}/2/broadcasts/scheduled/${created.data.broadcast_id}/live`,
      {
        method: 'POST',
        headers: signed,
        body: '{}'
      }
    )
    assert.equal(auto.status, 400)
    const openEnded = await fetch(
      `${fixture.origin}/2/broadcasts/scheduled/${created.data.broadcast_id}`,
      {
        method: 'PUT',
        headers: signed,
        body: JSON.stringify({
          scheduled_broadcast_id: created.data.scheduled_broadcast_id,
          scheduled_start_ms: '2051265600000'
        })
      }
    )
    assert.equal(openEnded.status, 400)
    assert.equal(fixture.xSchedules.get(created.data.broadcast_id).manual_publish, false)
  } finally {
    await fixture.close()
  }
})
