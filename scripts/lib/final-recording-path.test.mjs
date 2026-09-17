// Run: node --test scripts/lib/final-recording-path.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { orderedRecordingPathCandidates, resolveFinalRecordingPath } from './final-recording-path.mjs'

test('prefers an exported MP4 sibling over the temporary MKV stop path', async () => {
  const mkv = '/tmp/videorc-session.mkv'
  const mp4 = '/tmp/videorc-session.mp4'
  const path = await resolveFinalRecordingPath({
    started: { sessionId: 's1', outputPath: mkv },
    stopped: { sessionId: 's1', outputPath: mkv },
    exists: (candidate) => candidate === mkv || candidate === mp4,
    sleep: async () => {},
    now: () => 0,
  })

  assert.equal(path, mp4)
})

test('waits for a later finalized recording status path', async () => {
  const mkv = '/tmp/videorc-session.mkv'
  const mp4 = '/tmp/videorc-session.mp4'
  const statuses = []
  let now = 0

  const path = await resolveFinalRecordingPath({
    started: { sessionId: 's1', outputPath: mkv },
    stopped: { sessionId: 's1', outputPath: mkv },
    recordingStatusEvents: statuses,
    stopRequestedAt: 10,
    timeoutMs: 100,
    pollMs: 10,
    exists: (candidate) => candidate === mkv || (candidate === mp4 && now >= 20),
    sleep: async (ms) => {
      now += ms
      statuses.push({ sessionId: 's1', outputPath: mp4, state: 'idle', receivedAt: 20 })
    },
    now: () => now,
  })

  assert.equal(path, mp4)
})

test('waits through the gap after the temporary MKV disappears before MP4 is visible', async () => {
  const mkv = '/tmp/videorc-session.mkv'
  const mp4 = '/tmp/videorc-session.mp4'
  let now = 0

  const path = await resolveFinalRecordingPath({
    started: { sessionId: 's1', outputPath: mkv },
    stopped: { sessionId: 's1', outputPath: mkv },
    stopRequestedAt: 10,
    timeoutMs: 100,
    pollMs: 10,
    exists: (candidate) => {
      if (candidate === mkv) return now === 0
      if (candidate === mp4) return now >= 20
      return false
    },
    sleep: async (ms) => {
      now += ms
    },
    now: () => now,
  })

  assert.equal(path, mp4)
})

test('does not return a temporary MKV without an MP4 export failure event', async () => {
  const mkv = '/tmp/videorc-session.mkv'
  let now = 0

  const path = await resolveFinalRecordingPath({
    started: { sessionId: 's1', outputPath: mkv },
    stopped: { sessionId: 's1', outputPath: mkv },
    stopRequestedAt: 10,
    timeoutMs: 20,
    pollMs: 10,
    exists: (candidate) => candidate === mkv,
    sleep: async (ms) => {
      now += ms
    },
    now: () => now,
  })

  assert.equal(path, null)
})

test('falls back to an existing MKV when MP4 export fails', async () => {
  const mkv = '/tmp/videorc-session.mkv'
  const path = await resolveFinalRecordingPath({
    started: { sessionId: 's1', outputPath: mkv },
    stopped: { sessionId: 's1', outputPath: mkv },
    healthEvents: [{ sessionId: 's1', code: 'mp4-export-failed', receivedAt: 20 }],
    stopRequestedAt: 10,
    exists: (candidate) => candidate === mkv,
    sleep: async () => {},
    now: () => 20,
  })

  assert.equal(path, mkv)
})

test('orders later matching status paths before stop and start paths', () => {
  assert.deepEqual(
    orderedRecordingPathCandidates({
      started: { sessionId: 's1', outputPath: '/tmp/start.mkv' },
      stopped: { sessionId: 's1', outputPath: '/tmp/stop.mkv' },
      recordingStatusEvents: [
        { sessionId: 'other', outputPath: '/tmp/other.mp4', receivedAt: 20 },
        { sessionId: 's1', outputPath: '/tmp/final.mp4', receivedAt: 30 },
      ],
      stopRequestedAt: 10,
    }),
    ['/tmp/final.mp4', '/tmp/stop.mp4', '/tmp/stop.mkv', '/tmp/start.mp4', '/tmp/start.mkv']
  )
})
