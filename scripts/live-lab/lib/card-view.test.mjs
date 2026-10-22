import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCardView,
  escapeHtml,
  formatClock,
  formatUptime,
  msUntilPulse,
  renderCardText,
  sparklinePath
} from '../card/card-view.mjs'
import {
  applySnapshot,
  applyStep,
  collectStrings,
  createCardState,
  looksSensitive,
  sanitizeSnapshot,
  snapshotFromJournalLine
} from './card-state.mjs'

// The card is public on stream. These are independent of card-state.mjs's
// own screen on purpose: the test must catch a leak even if the screen has a
// hole.
const LEAK_PATTERNS = [
  ['email', /[\w.+-]+@[\w-]+\.[\w.]+/],
  ['home path', /\/Users\/|\/home\/|~\/|C:\\Users\\/i],
  ['stream url', /rtmps?:\/\//i],
  ['youtube stream key', /\b[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i],
  ['google token', /ya29\.|1\/\/0|AIza/],
  ['github token', /gh[pos]_|github_pat_/],
  ['bearer', /Bearer\s/i],
  ['jwt', /eyJ[\w-]{8,}/],
  ['long opaque string', /[A-Za-z0-9+/]{24,}/]
]

function assertNoLeak(text) {
  for (const [name, pattern] of LEAK_PATTERNS) {
    assert.doesNotMatch(text, pattern, `card text leaks a ${name}`)
  }
}

const NOW = Date.parse('2026-10-12T10:20:00.000Z')
const START = Date.parse('2026-10-12T10:00:00.000Z')

function stateFrom(runInfo, snapshots, step) {
  let state = createCardState(runInfo)
  for (const input of snapshots) state = applySnapshot(state, sanitizeSnapshot(input, NOW).snapshot)
  if (step !== undefined) state = applyStep(state, step)
  return state
}

const CLEAN_FIXTURE = {
  runInfo: {
    runId: '20261012-marathon-7f3a',
    scenario: 'marathon',
    appVersion: '0.9.142',
    startedAt: START
  },
  snapshots: Array.from({ length: 24 }, (_, index) => ({
    ts: START + index * 5000,
    state: 'live',
    memoryMb: { backend: 400 + index, main: 180, renderer: 350 + index * 2, gpu: 220, ffmpeg: 140 },
    bitrateKbps: 6000 + (index % 3) * 50,
    droppedFrames: index > 20 ? 4 : 0,
    encoderSpeed: 1.0,
    openIncidents: index > 22 ? 1 : 0,
    healthEventCodes: index === 21 ? ['stream:dropped-frames'] : []
  })),
  step: { index: 7, total: 12, name: 'Comment highlighted', sceneId: 2 }
}

// Everything a careless harness might hand the card.
const HOSTILE_FIXTURE = {
  runInfo: {
    runId: 'person@example.com',
    scenario: '/Users/someone/videorc-live-lab',
    appVersion: '0.9.142',
    startedAt: START,
    streamKey: 'abcd-efgh-ijkl-mnop-qrst'
  },
  snapshots: [
    {
      ts: START,
      appVersion: 'ya29.a0AfH6SMBc0ffeeTokenValue1234567890',
      state: 'live',
      bitrateKbps: 6000,
      streamUrl: 'rtmps://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst',
      refreshToken: '1//0gExampleRefreshTokenValueThatIsLong',
      chat: [{ author: 'viewer', text: 'hello' }],
      memoryMb: { backend: 410, 'C:\\Users\\me': 3, ghp_abcdefghijklmnopqrstuvwxyz0123: 1 },
      healthEventCodes: [
        'stream:reconnected',
        'leak:/Users/someone/Library/Logs',
        'auth:Bearer abc',
        'person@example.com',
        'eyJhbGciOiJIUzI1NiJ9.payload',
        'abcd-efgh-ijkl-mnop-qrst',
        'AIzaSyExampleExampleExample00000000',
        'x'.repeat(200)
      ]
    }
  ],
  step: { index: 2, name: 'Paste key ghp_abcdefghijklmnopqrstuvwxyz0123', sceneId: 99 }
}

test('renders the clean fixture with the run facts and live numbers', () => {
  const state = stateFrom(CLEAN_FIXTURE.runInfo, CLEAN_FIXTURE.snapshots, CLEAN_FIXTURE.step)
  const text = renderCardText(state, NOW)
  for (const expected of [
    '20261012-marathon-7f3a',
    'marathon',
    'v0.9.142',
    'Step 7 of 12',
    'Comment highlighted',
    'stream:dropped-frames',
    '1 open incident',
    'Backend',
    'Renderer',
    'FFmpeg',
    'Step 0007',
    'Scene 2',
    '6,100'
  ]) {
    assert.ok(text.includes(expected), `card shows ${expected}`)
  }
  assertNoLeak(text)
  const view = buildCardView(state, NOW)
  assert.equal(view.uptime, '0:20:00')
  assert.equal(view.memory.length, 5)
  assert.ok(view.memory.every((line) => line.path.startsWith('M')))
})

test('the hostile fixture renders nothing secret-shaped', () => {
  const state = stateFrom(HOSTILE_FIXTURE.runInfo, HOSTILE_FIXTURE.snapshots, HOSTILE_FIXTURE.step)
  const text = renderCardText(state, NOW)
  assertNoLeak(text)
  assertNoLeak(collectStrings(state).join('\n'))
  assertNoLeak(JSON.stringify(state))
  // The safe parts still show.
  assert.ok(text.includes('stream:reconnected'))
  assert.ok(text.includes('v0.9.142'))
  assert.ok(text.includes('unnamed run'))
  assert.ok(!text.includes('Paste key'))
  assert.equal(state.step.sceneId, 0)
})

test('the screen flags each sensitive shape and passes normal labels', () => {
  for (const bad of [
    'person@example.com',
    '/Users/someone',
    '~/videorc',
    'rtmps://x',
    'abcd-efgh-ijkl-mnop',
    'ya29.abc',
    'ghp_x',
    'Bearer x',
    'aGVsbG8gd29ybGQgaGVsbG8gd29ybGQ=',
    'my stream_key'
  ]) {
    assert.equal(looksSensitive(bad), true, bad)
  }
  for (const good of [
    'stream:noData-while-live',
    'leak:renderer',
    'crash:videorc-backend:main',
    'comment-highlight-on-dual-orientation',
    '20261012-first-light-ab12',
    'Scene applied'
  ]) {
    assert.equal(looksSensitive(good), false, good)
  }
})

test('escapes markup in anything printed', () => {
  assert.equal(escapeHtml('<b a="1">&\''), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;')
})

test('formats the clock, uptime and pulse countdown', () => {
  assert.equal(formatClock(Date.parse('2026-10-12T14:03:22.417Z')), '14:03:22.417')
  assert.equal(formatUptime(3_723_000), '1:02:03')
  assert.equal(formatUptime(NaN), '0:00:00')
  assert.equal(msUntilPulse(1_000_000), 0)
  assert.equal(msUntilPulse(1_002_500), 7500)
})

test('sparklines span the newest 10 minutes and stay inside the box', () => {
  const points = Array.from({ length: 200 }, (_, index) => ({ ts: index * 5000, value: index % 7 }))
  const path = sparklinePath(points, { width: 300, height: 60 })
  const coords = path
    .slice(1)
    .split('L')
    .map((pair) => pair.split(',').map(Number))
  assert.equal(coords.length, 121)
  for (const [x, y] of coords) {
    assert.ok(x >= 0 && x <= 300 && y >= 0 && y <= 60)
  }
  assert.equal(sparklinePath([], {}), '')
  assert.match(sparklinePath([{ ts: 1, value: 3 }]), /^M296\.0,/)
})

test('maps a metrics-journal line to an allowlisted snapshot', () => {
  const snapshot = snapshotFromJournalLine({
    ts: '2026-10-12T10:00:05.000Z',
    appVersion: '0.9.142',
    sessionId: 'abc',
    state: 'live',
    legs: [
      { targetId: 't1', platform: 'youtube', bitrateKbps: 6000, droppedFrames: 2, speed: 1.01 },
      { targetId: 't2', platform: 'youtube', bitrateKbps: 3000, droppedFrames: 1, speed: 0.98 }
    ],
    backendRssBytes: 420 * 1048576,
    healthEventCodes: ['stream:reconnected']
  })
  assert.deepEqual(snapshot, {
    ts: '2026-10-12T10:00:05.000Z',
    appVersion: '0.9.142',
    state: 'live',
    memoryMb: { backend: 420 },
    bitrateKbps: 9000,
    droppedFrames: 3,
    encoderSpeed: 0.98,
    healthEventCodes: ['stream:reconnected']
  })
  assert.deepEqual(sanitizeSnapshot(snapshot, 0).dropped, [])
})
