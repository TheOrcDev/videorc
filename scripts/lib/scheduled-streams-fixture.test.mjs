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
    const createResponse = await fetch(`${fixture.origin}/2/sources`, {
      method: 'POST',
      headers: signed,
      body: JSON.stringify({ name: 'Videorc Scheduled 1', region: 'us-east-1' })
    })
    assert.equal(createResponse.status, 201)
    const source = await createResponse.json()
    // The source id is 19 digits and the key rides only with the create
    // response and the stream_key route; a stream key is never an id.
    assert.match(source.data.id, /^\d{19}$/)
    assert.equal(source.data.stream_key, 'scheduled-smoke-x')
    const listed = await fetch(`${fixture.origin}/2/sources`, { headers: signed }).then(
      (response) => response.json()
    )
    assert.equal(listed.meta.result_count, 1)
    assert.equal(listed.data[0].id, source.data.id)
    assert.equal(listed.data[0].stream_key, undefined)
    const read = await fetch(`${fixture.origin}/2/sources/${source.data.id}`, {
      headers: signed
    }).then((response) => response.json())
    assert.equal(read.data.stream_key, undefined)
    assert.equal(read.data.region, 'us-east-1')
    const key = await fetch(`${fixture.origin}/2/sources/${source.data.id}/stream_key`, {
      headers: signed
    }).then((response) => response.json())
    assert.deepEqual(key, { data: { id: source.data.id, stream_key: 'scheduled-smoke-x' } })
    const asKey = await fetch(`${fixture.origin}/2/sources/scheduled-smoke-x`, {
      headers: signed
    })
    assert.equal(asKey.status, 400)
    assert.equal((await asKey.json()).detail, 'The `id` value is not a source id.')
    const strict = await fetch(`${fixture.origin}/2/sources`, {
      method: 'POST',
      headers: signed,
      body: JSON.stringify({ name: 'x', region: 'us-east-1', is_low_latency: true })
    })
    assert.equal(strict.status, 400)
    const goLive = await fetch(`${fixture.origin}/2/broadcasts`, {
      method: 'POST',
      headers: signed,
      body: JSON.stringify({ source_id: source.data.id, title: 'x', region: 'us-east-1' })
    })
    assert.equal(goLive.status, 400, 'unknown Go Live fields are rejected')
    const created = await fetch(`${fixture.origin}/2/broadcasts/scheduled`, {
      method: 'POST',
      headers: signed,
      body: JSON.stringify({
        source_id: source.data.id,
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
    const ended = await fetch(`${fixture.origin}/2/broadcasts/${created.data.broadcast_id}/state`, {
      method: 'PUT',
      headers: signed,
      body: JSON.stringify({ state: 'END' })
    }).then((response) => response.json())
    assert.deepEqual(ended, { data: { id: created.data.broadcast_id, state: 'ENDED' } })
    const broadcast = await fetch(`${fixture.origin}/2/broadcasts/${created.data.broadcast_id}`, {
      headers: signed
    }).then((response) => response.json())
    assert.equal(broadcast.data.share_url, `https://x.com/i/broadcasts/${created.data.broadcast_id}`)
    assert.equal(broadcast.data.media_id, undefined)
    assert.match(broadcast.data.media_key, /^28_\d+$/)
    assert.ok(
      fixture.calls.every((call) => !call.path.startsWith('/2/users/')),
      'no deprecated user-prefixed route is served'
    )
  } finally {
    await fixture.close()
  }
})
