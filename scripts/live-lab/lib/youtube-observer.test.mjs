import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FAKE_YOUTUBE_ACCESS_TOKEN,
  FAKE_YOUTUBE_CHANNEL_ID,
  startFakeYouTubeApi
} from '../../lib/fake-youtube-api.mjs'
import { createQuotaLedger } from './quota-ledger.mjs'
import { createYoutubeObserver, evaluateSnapshot, isNoData } from './youtube-observer.mjs'

const NOW = new Date('2026-10-12T15:00:00Z')

async function setup({ maxUnitsPerDay = 8000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'videorc-observer-'))
  const fake = await startFakeYouTubeApi()
  const ledger = createQuotaLedger({ dir, maxUnitsPerDay, now: () => NOW })
  fake.streams.set('stream-1', {
    kind: 'youtube#liveStream',
    id: 'stream-1',
    snippet: { channelId: FAKE_YOUTUBE_CHANNEL_ID },
    cdn: { resolution: '1080p', frameRate: '30fps' },
    status: { streamStatus: 'active', healthStatus: { status: 'good', configurationIssues: [] } }
  })
  fake.broadcasts.set('old-ready', {
    id: 'old-ready',
    snippet: { channelId: FAKE_YOUTUBE_CHANNEL_ID, liveChatId: 'other-chat' },
    status: { lifeCycleStatus: 'ready', privacyStatus: 'private' },
    contentDetails: {}
  })
  fake.broadcasts.set('bc-live', {
    id: 'bc-live',
    snippet: { channelId: FAKE_YOUTUBE_CHANNEL_ID, liveChatId: 'smoke-live-chat' },
    status: { lifeCycleStatus: 'live', privacyStatus: 'unlisted' },
    contentDetails: { boundStreamId: 'stream-1' }
  })
  const state = { onAir: true, studioEnded: [] }
  const observer = createYoutubeObserver({
    getToken: async (role) => {
      assert.equal(role, 'broadcaster')
      return FAKE_YOUTUBE_ACCESS_TOKEN
    },
    ledger,
    apiBase: fake.origin,
    now: () => NOW,
    appOnAir: () => state.onAir,
    onStudioEnded: (snapshot) => state.studioEnded.push(snapshot)
  })
  const cleanup = async () => {
    await fake.close()
    await rm(dir, { recursive: true, force: true })
  }
  return { fake, ledger, observer, state, cleanup }
}

test('poll reads broadcast, bound stream, video and chat for 4 units', async () => {
  const { fake, ledger, observer, cleanup } = await setup()
  try {
    fake.postChat('first message', 'some_viewer')
    const snapshot = await observer.poll()
    assert.deepEqual(snapshot.broadcast, {
      id: 'bc-live',
      channelId: FAKE_YOUTUBE_CHANNEL_ID,
      liveChatId: 'smoke-live-chat',
      lifeCycleStatus: 'live',
      privacyStatus: 'unlisted',
      boundStreamId: 'stream-1'
    })
    assert.deepEqual(snapshot.stream, {
      id: 'stream-1',
      streamStatus: 'active',
      healthStatus: 'good',
      configurationIssues: [],
      resolution: '1080p',
      frameRate: '30fps'
    })
    assert.equal(snapshot.video.concurrentViewers, 7)
    assert.deepEqual(
      snapshot.chat.newMessages.map((message) => message.text),
      ['first message']
    )
    assert.equal(snapshot.appOnAir, true)
    assert.deepEqual(snapshot.errors, [])
    assert.deepEqual(snapshot.incidents, [])
    assert.equal(ledger.today().units, 4)
    assert.equal(snapshot.quota.units, 4)
    assert.equal(observer.broadcastId, 'bc-live')

    const discovery = fake.requests.find((entry) => entry.path === '/youtube/v3/liveBroadcasts')
    assert.equal(discovery.query.broadcastStatus, 'active')
    assert.equal(discovery.query.broadcastType, 'all')
    const streamRead = fake.requests.find((entry) => entry.path === '/youtube/v3/liveStreams')
    assert.equal(streamRead.query.id, 'stream-1')

    // Second poll: pinned by id, chat resumes from its page token.
    fake.postChat('second message', 'some_viewer')
    const next = await observer.poll()
    const pinned = fake.requests.filter((entry) => entry.path === '/youtube/v3/liveBroadcasts')[1]
    assert.equal(pinned.query.id, 'bc-live')
    assert.equal(pinned.query.broadcastStatus, undefined)
    assert.deepEqual(
      next.chat.newMessages.map((message) => message.text),
      ['second message']
    )
    assert.equal(ledger.today().units, 8)

    // Reports-safe: no token, no chat author names or channel ids.
    const text = JSON.stringify([snapshot, next])
    assert.ok(!text.includes(FAKE_YOUTUBE_ACCESS_TOKEN))
    assert.ok(!text.includes('some_viewer'))
  } finally {
    await cleanup()
  }
})

test('P0 after two consecutive noData polls while the app is On air, once per streak', async () => {
  const { fake, observer, state, cleanup } = await setup()
  try {
    const stream = fake.streams.get('stream-1')
    stream.status = { streamStatus: 'inactive', healthStatus: { status: 'noData' } }
    assert.deepEqual((await observer.poll()).incidents, [])
    const second = await observer.poll()
    assert.equal(second.incidents.length, 1)
    assert.equal(second.incidents[0].signature, 'stream:noData-while-live')
    assert.equal(second.incidents[0].severity, 'P0')
    assert.deepEqual((await observer.poll()).incidents, [], 'raised once per streak')

    // Data back, then lost again: a new streak raises again.
    stream.status = { streamStatus: 'active', healthStatus: { status: 'good' } }
    await observer.poll()
    stream.status = { streamStatus: 'active', healthStatus: { status: 'noData' } }
    await observer.poll()
    assert.equal((await observer.poll()).incidents[0]?.signature, 'stream:noData-while-live')

    // App not On air: noData is expected, never an incident.
    state.onAir = false
    stream.status = { streamStatus: 'inactive', healthStatus: { status: 'noData' } }
    await observer.poll()
    assert.deepEqual((await observer.poll()).incidents, [])
  } finally {
    await cleanup()
  }
})

test('broadcast complete while On air raises studio-ended and calls the kill switch hook once', async () => {
  const { fake, observer, state, cleanup } = await setup()
  try {
    await observer.poll()
    fake.broadcasts.get('bc-live').status.lifeCycleStatus = 'complete'
    const ended = await observer.poll()
    assert.equal(ended.broadcast.lifeCycleStatus, 'complete')
    assert.deepEqual(
      ended.incidents.map((incident) => [incident.type, incident.severity]),
      [['studio-ended', 'P0']]
    )
    assert.equal(state.studioEnded.length, 1)
    await observer.poll()
    assert.equal(state.studioEnded.length, 1)
  } finally {
    await cleanup()
  }
})

test('health bad, sustained ok and each new configuration issue raise incidents', async () => {
  const { fake, observer, cleanup } = await setup()
  try {
    const stream = fake.streams.get('stream-1')
    stream.status.healthStatus = {
      status: 'bad',
      configurationIssues: [
        { type: 'bitrateLow', severity: 'error', reason: 'Low bitrate', description: 'x' }
      ]
    }
    const bad = await observer.poll()
    assert.deepEqual(bad.incidents.map((incident) => incident.signature).sort(), [
      'youtube-config:bitrateLow',
      'youtube-health:bad'
    ])
    assert.deepEqual((await observer.poll()).incidents, [], 'same state raises nothing new')

    stream.status.healthStatus = {
      status: 'ok',
      configurationIssues: [
        { type: 'bitrateLow', severity: 'error' },
        { type: 'gopSizeLong', severity: 'warning' }
      ]
    }
    assert.deepEqual(
      (await observer.poll()).incidents.map((incident) => incident.signature),
      ['youtube-config:gopSizeLong']
    )
    await observer.poll()
    assert.deepEqual(
      (await observer.poll()).incidents.map((incident) => incident.signature),
      ['youtube-health:ok-sustained']
    )
  } finally {
    await cleanup()
  }
})

test('a failed stream read is unknown: recorded, neither noData nor reset', async () => {
  const { fake, observer, cleanup } = await setup()
  try {
    fake.streams.get('stream-1').status = { streamStatus: 'inactive' }
    await observer.poll()
    fake.controls.quotaExhausted = true
    const failed = await observer.poll()
    assert.ok(failed.errors.some((error) => error.call === 'liveStreams.list'))
    assert.ok(failed.errors.every((error) => error.status === 403))
    assert.deepEqual(failed.incidents, [])
    fake.controls.quotaExhausted = false
    assert.equal((await observer.poll()).incidents[0]?.signature, 'stream:noData-while-live')
  } finally {
    await cleanup()
  }
})

test('watch polls until aborted and stops on a ledger refusal', async () => {
  const { fake, observer, cleanup } = await setup({ maxUnitsPerDay: 10 })
  try {
    const snapshots = []
    const incidents = []
    const summary = await observer.watch({
      intervalMs: 5,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onIncident: (incident) => incidents.push(incident)
    })
    // 10 units: two full polls (8), the third poll is refused part way.
    assert.equal(summary.stoppedBy, 'quota')
    assert.equal(summary.polls, 2)
    assert.equal(snapshots.length, 2)
    assert.equal(incidents.at(-1).signature, 'observer:quota-refused')
    assert.ok(fake.requests.length <= 10)
  } finally {
    await cleanup()
  }

  const second = await setup()
  try {
    const controller = new AbortController()
    let polls = 0
    const summary = await second.observer.watch({
      intervalMs: 1,
      signal: controller.signal,
      onSnapshot: () => {
        polls += 1
        if (polls === 3) controller.abort()
      }
    })
    assert.deepEqual([summary.stoppedBy, summary.polls], ['signal', 3])
  } finally {
    await second.cleanup()
  }
})

test('isOwnVideo checks the broadcast belongs to the broadcaster channel', async () => {
  const { fake, observer, cleanup } = await setup()
  try {
    assert.equal(await observer.isOwnVideo('bc-live'), true)
    assert.equal(await observer.isOwnVideo('missing'), false)
    fake.broadcasts.set('foreign', {
      id: 'foreign',
      snippet: { channelId: 'UC-someone-else' },
      status: { lifeCycleStatus: 'live' },
      contentDetails: {}
    })
    assert.equal(await observer.isOwnVideo('foreign'), false)
    assert.equal(await observer.isOwnVideo(''), false)
    // channels.list once (cached), then one liveBroadcasts.list per check.
    assert.equal(fake.requests.filter((entry) => entry.path === '/youtube/v3/channels').length, 1)
  } finally {
    await cleanup()
  }
})

test('pure rules: noData covers a missing stream; unknown appOnAir never raises', () => {
  assert.equal(isNoData(null), true)
  assert.equal(isNoData({ streamStatus: 'active', healthStatus: 'good' }), false)
  assert.equal(isNoData({ streamStatus: 'active', healthStatus: 'noData' }), true)
  const base = { at: NOW.toISOString(), stream: null, broadcast: null, errors: [] }
  let state
  for (let poll = 0; poll < 3; poll += 1) {
    const result = evaluateSnapshot({ ...base, appOnAir: null }, state)
    assert.deepEqual(result.incidents, [])
    state = result.state
  }
})
