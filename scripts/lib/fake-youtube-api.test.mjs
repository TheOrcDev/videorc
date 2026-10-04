import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FAKE_YOUTUBE_ACCESS_TOKEN,
  chatPage,
  deleteFailureResponse,
  isDataApiPath,
  quotaExceededBody,
  startFakeYouTubeApi,
  summarizeYouTubeAttempts,
  youtubeAttemptCost
} from './fake-youtube-api.mjs'

test('only Data API paths spend quota', () => {
  assert.equal(isDataApiPath('/youtube/v3/liveChat/messages'), true)
  assert.equal(isDataApiPath('/upload/youtube/v3/thumbnails/set'), true)
  assert.equal(isDataApiPath('/token'), false)
  assert.equal(isDataApiPath('/revoke'), false)
})

test('a chat page resumes from its token and advances to the end', () => {
  const messages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const first = chatPage(messages, undefined)
  assert.deepEqual(
    first.items.map((item) => item.id),
    ['a', 'b', 'c']
  )
  assert.equal(first.nextPageToken, '3')
  const later = chatPage(messages, '2')
  assert.deepEqual(
    later.items.map((item) => item.id),
    ['c']
  )
  assert.equal(chatPage(messages, '99').items.length, 0)
  assert.equal(chatPage(messages, 'garbage').items.length, 3)
  assert.equal(first.pollingIntervalMillis, 1000)
})

test('the quota envelope carries Google reason and domain', () => {
  const body = quotaExceededBody()
  assert.equal(body.error.errors[0].reason, 'quotaExceeded')
  assert.equal(body.error.errors[0].domain, 'youtube.quota')
  assert.match(body.error.message, /<a href=/)
})

test('the fake serves prepare, chat and viewers, then flips to quotaExceeded on command', async () => {
  const api = await startFakeYouTubeApi({ ingestUrl: 'rtmp://127.0.0.1:19000/live' })
  try {
    const headers = { authorization: `Bearer ${FAKE_YOUTUBE_ACCESS_TOKEN}` }
    const unauthorized = await fetch(`${api.origin}/youtube/v3/channels?part=id&mine=true`)
    assert.equal(unauthorized.status, 401)

    const token = await fetch(`${api.origin}/token`, { method: 'POST', body: 'code=x' })
    assert.equal((await token.json()).access_token, FAKE_YOUTUBE_ACCESS_TOKEN)

    const created = await (
      await fetch(`${api.origin}/youtube/v3/liveBroadcasts?part=snippet`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ snippet: { title: 'Smoke' }, status: {}, contentDetails: {} })
      })
    ).json()
    assert.equal(created.snippet.liveChatId, 'smoke-live-chat')
    const stream = await (
      await fetch(`${api.origin}/youtube/v3/liveStreams?part=cdn`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ snippet: {}, cdn: {} })
      })
    ).json()
    assert.equal(stream.cdn.ingestionInfo.ingestionAddress, 'rtmp://127.0.0.1:19000/live')
    const bound = await fetch(
      `${api.origin}/youtube/v3/liveBroadcasts/bind?id=${created.id}&streamId=${stream.id}`,
      { method: 'POST', headers }
    )
    assert.equal(bound.status, 200)
    const live = await (
      await fetch(
        `${api.origin}/youtube/v3/liveBroadcasts/transition?broadcastStatus=live&id=${created.id}`,
        { method: 'POST', headers }
      )
    ).json()
    assert.equal(live.status.lifeCycleStatus, 'live')

    api.postChat('hello')
    const page = await (
      await fetch(`${api.origin}/youtube/v3/liveChat/messages?liveChatId=smoke-live-chat`, {
        headers
      })
    ).json()
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].snippet.displayMessage, 'hello')
    const viewers = await (
      await fetch(`${api.origin}/youtube/v3/videos?part=liveStreamingDetails&id=${created.id}`, {
        headers
      })
    ).json()
    assert.equal(viewers.items[0].liveStreamingDetails.concurrentViewers, '7')

    const before = api.requests.length
    api.controls.quotaExhausted = true
    const refused = await fetch(`${api.origin}/youtube/v3/liveChat/messages?liveChatId=x`, {
      headers
    })
    assert.equal(refused.status, 403)
    assert.equal((await refused.json()).error.errors[0].reason, 'quotaExceeded')
    // OAuth routes never spend quota, so they keep answering.
    const tokenWhilePaused = await fetch(`${api.origin}/token`, { method: 'POST' })
    assert.equal(tokenWhilePaused.status, 200)
    const dataCalls = api.requests.slice(before).filter((entry) => entry.dataApi)
    assert.equal(dataCalls.length, 1)
    assert.equal(api.dataApiRequestsSince(Date.now() + 1000).length, 0)
    assert.equal(dataCalls[0].quotaExhausted, true)
    assert.ok(api.requests.length >= 9)
  } finally {
    await api.close()
  }
})

test('a chat message delete answers 204, costs 50 units and takes scripted failures', async () => {
  const api = await startFakeYouTubeApi()
  try {
    const headers = { authorization: `Bearer ${FAKE_YOUTUBE_ACCESS_TOKEN}` }
    const posted = api.postChat('please remove me')
    const removed = await fetch(`${api.origin}/youtube/v3/liveChat/messages?id=${posted.id}`, {
      method: 'DELETE',
      headers
    })
    assert.equal(removed.status, 204)
    assert.equal(await removed.text(), '')
    assert.deepEqual(api.chat.deleted, [posted.id])
    // Never a list page: the old fake answered DELETE as one.
    const page = await (
      await fetch(`${api.origin}/youtube/v3/liveChat/messages?liveChatId=smoke-live-chat`, {
        headers
      })
    ).json()
    assert.equal(page.items.length, 1, 'the list keeps its indexes')

    const unknown = await fetch(`${api.origin}/youtube/v3/liveChat/messages?id=nope`, {
      method: 'DELETE',
      headers
    })
    assert.equal(unknown.status, 404)

    api.controls.deleteFailure = 'forbidden'
    const forbidden = await fetch(`${api.origin}/youtube/v3/liveChat/messages?id=${posted.id}`, {
      method: 'DELETE',
      headers
    })
    assert.equal(forbidden.status, 403)
    assert.equal((await forbidden.json()).error.errors[0].reason, 'insufficientPermissions')
    api.controls.deleteFailure = 'quota'
    const quota = await fetch(`${api.origin}/youtube/v3/liveChat/messages?id=${posted.id}`, {
      method: 'DELETE',
      headers
    })
    assert.equal((await quota.json()).error.errors[0].reason, 'quotaExceeded')
    assert.equal(deleteFailureResponse('not-found').status, 404)
    assert.equal(deleteFailureResponse(null), null)

    assert.deepEqual(youtubeAttemptCost('DELETE', '/youtube/v3/liveChat/messages'), {
      endpoint: 'liveChatMessages.delete',
      units: 50
    })
    const summary = summarizeYouTubeAttempts(api.requests)
    assert.equal(summary.unknown, 0)
    assert.equal(summary.endpoints['liveChatMessages.delete'].calls, 4)
    assert.equal(summary.endpoints['liveChatMessages.delete'].units, 200)
    assert.equal(summary.endpoints['liveChatMessages.delete'].outcomes['204'], 1)
  } finally {
    await api.close()
  }
})
