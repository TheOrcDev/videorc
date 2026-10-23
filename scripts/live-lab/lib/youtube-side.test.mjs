import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFakeClock } from './harness-test-fakes.mjs'
import { createQuotaLedger } from './quota-ledger.mjs'
import { createEventBus } from './step-engine.mjs'
import { createYoutubeSide, isLiveJournalState } from './youtube-side.mjs'

// The live lab runs on macOS and Linux only (POSIX paths, modes and shells).
const posixOnly = {
  skip: process.platform === 'win32' && 'the live lab runs on macOS and Linux only'
}

const NOW = new Date('2026-10-12T15:00:00Z')

function fakeObserver({ snapshots, studioEndedAt = null }) {
  let index = 0
  return ({ onStudioEnded, appOnAir }) => ({
    broadcastId: 'bc-live',
    isOwnVideo: async (id) => id === 'bc-live',
    async poll() {
      const snapshot = {
        ...(snapshots[Math.min(index, snapshots.length - 1)] ?? {}),
        appOnAir: appOnAir(),
        incidents: []
      }
      index += 1
      if (studioEndedAt === index) {
        snapshot.incidents = [
          { type: 'studio-ended', signature: 'studio-ended', severity: 'P0', detail: 'ended' }
        ]
        onStudioEnded(snapshot)
      }
      return snapshot
    },
    async watch({ onSnapshot, onIncident, signal }) {
      let polls = 0
      while (!signal.aborted && polls < snapshots.length) {
        const snapshot = await this.poll()
        polls += 1
        onSnapshot(snapshot)
        for (const incident of snapshot.incidents) onIncident(incident)
        await new Promise((resolve) => setImmediate(resolve))
      }
      return { polls, incidents: [], stoppedBy: signal.aborted ? 'signal' : 'done' }
    }
  })
}

async function rig({ clipPull = false, snapshots, studioEndedAt, pull } = {}) {
  const runDir = await mkdtemp(join(tmpdir(), 'videorc-yt-side-'))
  const ledger = createQuotaLedger({ dir: runDir, now: () => NOW })
  const bus = createEventBus()
  const events = []
  bus.on((type, payload) => events.push([type, payload]))
  const pulls = []
  const side = createYoutubeSide({
    config: {},
    policy: { clipPull },
    ledger,
    runDir,
    bus,
    appOnAir: () => true,
    clock: createFakeClock(NOW.getTime()),
    getToken: async () => 'fake',
    createObserver: fakeObserver({
      snapshots: snapshots ?? [
        { at: NOW.toISOString(), broadcast: { id: 'bc-live', liveChatId: 'chat-1' }, stream: {} }
      ],
      studioEndedAt
    }),
    createViewer: () => ({ runScript: async () => ({ sent: [] }) }),
    pull:
      pull ??
      (async (options) => {
        pulls.push(options)
        return {
          status: 'analyzed',
          videoId: 'bc-live',
          analysisPath: '/x/clip.analysis.json',
          incidents: []
        }
      })
  })
  return {
    side,
    runDir,
    ledger,
    bus,
    events,
    pulls,
    cleanup: () => rm(runDir, { recursive: true, force: true })
  }
}

test('isLiveJournalState', () => {
  assert.equal(isLiveJournalState('live'), true)
  assert.equal(isLiveJournalState('both'), true)
  assert.equal(isLiveJournalState('idle'), false)
  assert.equal(isLiveJournalState(null), false)
})

test('snapshots land in observer.ndjson, incidents reach the bus, Studio end calls the hook', async () => {
  const { side, runDir, events, cleanup } = await rig({
    studioEndedAt: 2,
    snapshots: [{ a: 1 }, { a: 2 }]
  })
  try {
    const ended = []
    side.observer.attach({ onStudioEnded: (snapshot) => ended.push(snapshot) })
    await side.start()
    for (let i = 0; i < 50 && events.filter(([type]) => type === 'observer').length < 2; i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const summary = await side.stop()
    assert.equal(summary.polls, 2)
    assert.deepEqual(summary.incidents, ['studio-ended'])
    assert.equal(ended.length, 1)
    assert.deepEqual(
      side.observer.incidents().map((incident) => incident.signature),
      ['studio-ended']
    )
    const lines = (await readFile(join(runDir, 'observer.ndjson'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).appOnAir, true)
    assert.ok(events.some(([type]) => type === 'observer'))
    assert.ok(events.some(([type, payload]) => type === 'incident' && payload.severity === 'P0'))
    const quota = JSON.parse(await readFile(join(runDir, 'quota.json'), 'utf8'))
    assert.equal(quota.schema, 1)
    assert.equal(quota.labUnits, 0)
    assert.equal(quota.bundledUnits, 0)
  } finally {
    await cleanup()
  }
})

test('clip pulls are skipped and recorded when the policy has clipPull off', async () => {
  const { side, runDir, pulls, cleanup } = await rig({ clipPull: false })
  try {
    await side.start()
    const result = await side.observer.pullClip({ reason: 'step' })
    assert.deepEqual(result, {
      status: 'skipped',
      reason: 'clip-pull-disabled',
      videoId: 'bc-live'
    })
    assert.equal(pulls.length, 0)
    await side.stop()
    const record = JSON.parse(await readFile(join(runDir, 'clips', 'pulls.ndjson'), 'utf8'))
    assert.equal(record.status, 'skipped')
    assert.equal(record.reason, 'clip-pull-disabled')
    assert.equal(record.trigger, 'step')
  } finally {
    await cleanup()
  }
})

test(
  'with clipPull on, pulls go to the run folder and incidents are recorded',
  posixOnly,
  async () => {
    const { side, runDir, pulls, cleanup } = await rig({
      clipPull: true,
      pull: async (options) => {
        pulls.push(options)
        return {
          status: 'analyzed',
          videoId: 'bc-live',
          analysisPath: join(options.outDir, 'clip-bc-live.analysis.json'),
          kept: true,
          incidents: [
            { type: 'clip:freeze', signature: 'clip:freeze', severity: 'P1', detail: 'f' }
          ]
        }
      }
    })
    try {
      await side.start()
      await side.observer.pullClip({ seconds: 30, reason: 'step' })
      assert.equal(pulls.length, 1)
      assert.equal(pulls[0].url, 'https://www.youtube.com/watch?v=bc-live')
      assert.equal(pulls[0].seconds, 30)
      assert.equal(pulls[0].outDir, join(runDir, 'clips'))
      assert.equal(pulls[0].clipPull, true)
      assert.equal(await pulls[0].isOwnVideo('bc-live'), true)
      assert.deepEqual(
        side.observer.incidents().map((incident) => incident.signature),
        ['clip:freeze']
      )
      const record = side.observer.clipResults()[0]
      assert.equal(record.analysis, 'clip-bc-live.analysis.json')
      assert.equal(record.clipKept, true)
      await side.stop()
    } finally {
      await cleanup()
    }
  }
)
