import assert from 'node:assert/strict'
import test from 'node:test'

import { createEventBus } from './step-engine.mjs'
import { createAppObserver } from './app-observer.mjs'
import { featureRecordsFromEvent, phraseOverlap, textHash } from './feature-events.mjs'

const TS = '2026-10-12T06:00:00.000Z'

test('chat messages keep the lab tag text and drop the author', () => {
  const [tagged] = featureRecordsFromEvent(
    {
      event: 'liveChat.message',
      payload: {
        message: {
          id: 'm1',
          platform: 'youtube',
          authorName: 'Some Viewer',
          authorId: 'UCxyz',
          messageText: '[lab 2026-10-12-chat-a1b2c3] hello from the viewer bot',
          receivedAt: '2026-10-12T06:00:01.000Z',
          eventType: 'message',
          authorRoles: []
        }
      }
    },
    TS
  )
  assert.deepEqual(tagged, {
    kind: 'chat',
    ts: '2026-10-12T06:00:01.000Z',
    id: 'm1',
    platform: 'youtube',
    eventType: 'message',
    text: '[lab 2026-10-12-chat-a1b2c3] hello from the viewer bot',
    textHash: textHash('[lab 2026-10-12-chat-a1b2c3] hello from the viewer bot'),
    isDeleted: false,
    isOwner: false
  })
  assert.ok(!JSON.stringify(tagged).includes('Some Viewer'))
  const [plain] = featureRecordsFromEvent(
    { event: 'liveChat.message', payload: { id: 'm2', messageText: 'a real viewer wrote this' } },
    TS
  )
  assert.equal(plain.text, null)
  assert.equal(plain.textHash, textHash('a real viewer wrote this'))
  const snapshot = featureRecordsFromEvent(
    {
      event: 'liveChat.snapshot',
      payload: { messages: [{ id: 'a' }, { nope: true }, { id: 'b' }] }
    },
    TS
  )
  assert.deepEqual(
    snapshot.map((record) => record.id),
    ['a', 'b']
  )
})

test('highlight, caption, clip mark and status events map to records', () => {
  assert.deepEqual(
    featureRecordsFromEvent(
      {
        event: 'comments.highlight.status',
        payload: { phase: 'live', messageId: 'm1', generation: 3 }
      },
      TS
    ),
    [{ kind: 'highlight', ts: TS, phase: 'live', messageId: 'm1', generation: 3, reason: null }]
  )
  assert.deepEqual(
    featureRecordsFromEvent(
      { event: 'captions.update', payload: { kind: 'final', seq: 7, text: 'The quick brown fox' } },
      TS
    ),
    [
      {
        kind: 'caption',
        ts: TS,
        captionKind: 'final',
        seq: 7,
        text: 'The quick brown fox',
        textHash: textHash('The quick brown fox')
      }
    ]
  )
  assert.deepEqual(
    featureRecordsFromEvent(
      { event: 'clip.marked', payload: { atSeconds: 12.5, source: 'voice', saved: true } },
      TS
    ),
    [{ kind: 'clip-mark', ts: TS, atSeconds: 12.5, source: 'voice', saved: true, reason: null }]
  )
  assert.deepEqual(
    featureRecordsFromEvent(
      { event: 'session.marker.voice.status', payload: { listening: { listening: true } } },
      TS
    ),
    [{ kind: 'voice-marker-status', ts: TS, listening: { listening: true } }]
  )
  assert.deepEqual(
    featureRecordsFromEvent(
      { event: 'captions.status', payload: { enabled: false, reason: 'off' } },
      TS
    ),
    [{ kind: 'captions-status', ts: TS, enabled: false, reason: 'off' }]
  )
  assert.deepEqual(featureRecordsFromEvent({ event: 'remote.state', payload: {} }, TS), [])
  assert.deepEqual(featureRecordsFromEvent(null, TS), [])
})

test('phraseOverlap scores shared words', () => {
  assert.equal(phraseOverlap('The quick brown fox jumps', 'the quick brown fox jumps'), 1)
  assert.ok(phraseOverlap('The quick brown fox jumps over the lazy dog', 'quick brown fox') < 0.5)
  assert.equal(phraseOverlap('', 'anything'), 0)
})

test('the app observer records feature events once and emits them on the bus', async () => {
  const bus = createEventBus()
  const written = []
  const observer = createAppObserver({
    bus,
    card: null,
    runDir: '/run',
    journalDirs: [],
    ledgerPaths: () => [],
    rootPid: async () => null,
    append: async (path, text) => {
      written.push([path, text])
    }
  })
  const seen = []
  bus.on((type, payload) => type === 'feature' && seen.push(payload))
  const chat = { event: 'liveChat.message', payload: { id: 'm1', messageText: 'x' } }
  observer.onBackendMessage(chat)
  observer.onBackendMessage(chat)
  observer.onBackendMessage({
    event: 'liveChat.message',
    payload: { id: 'm1', messageText: 'x', isDeleted: true }
  })
  observer.onBackendMessage({ event: 'clip.marked', payload: { atSeconds: 1, saved: false } })
  assert.equal(seen.length, 3)
  assert.deepEqual(
    observer.featureEvents().map((record) => record.kind),
    ['chat', 'chat', 'clip-mark']
  )
  assert.equal(observer.featureEvents('clip-mark').length, 1)
  assert.equal(written.filter(([path]) => path.endsWith('events.ndjson')).length, 3)
})
