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
