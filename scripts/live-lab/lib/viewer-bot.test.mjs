import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { startFakeYouTubeApi } from '../../lib/fake-youtube-api.mjs'
import { QuotaRefused, createQuotaLedger } from './quota-ledger.mjs'
import {
  BURST_SIZE,
  MAX_MESSAGE_CHARS,
  createViewerBot,
  messageSpacingMs,
  scriptCost,
  scriptedMessages,
  validateMessage
} from './viewer-bot.mjs'

const VIEWER_TOKEN = 'lab-viewer-access-token'
const NOW = new Date('2026-10-12T15:00:00Z')

async function setup({ maxUnitsPerDay = 8000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'videorc-viewer-bot-'))
  const fake = await startFakeYouTubeApi({
    extraTokens: { [VIEWER_TOKEN]: { authorName: 'lab_viewer' } }
  })
  const ledger = createQuotaLedger({ dir, maxUnitsPerDay, now: () => NOW })
  const sleeps = []
  const bot = createViewerBot({
    getToken: async (role) => {
      assert.equal(role, 'viewer')
      return VIEWER_TOKEN
    },
    ledger,
    apiBase: fake.origin,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms)
    }
  })
  const cleanup = async () => {
    await fake.close()
    await rm(dir, { recursive: true, force: true })
  }
  return { fake, ledger, bot, sleeps, cleanup }
}

test('suite C message set: plain, emoji, link, exactly 200 chars, a burst of 10, all tagged', () => {
  const messages = scriptedMessages('run-42')
  assert.deepEqual(
    messages.slice(0, 4).map((message) => message.kind),
    ['plain', 'emoji', 'link', 'long']
  )
  assert.equal(messages.filter((message) => message.kind.startsWith('burst-')).length, BURST_SIZE)
  assert.equal(messages[3].text.length, MAX_MESSAGE_CHARS)
  assert.match(messages[2].text, /https:\/\/www\.videorc\.com/)
  assert.match(messages[1].text, /\p{Extended_Pictographic}/u)
  for (const message of messages) {
    assert.ok(message.text.startsWith('[lab run-42]'), message.kind)
    assert.doesNotThrow(() => validateMessage(message.text))
  }
  assert.equal(new Set(messages.map((message) => message.text)).size, messages.length)
  assert.equal(scriptCost('run-42'), 14 * 50 + 50)
})

test('spacing respects slow mode (viewers only) with a margin, 1 s floor without it', () => {
  assert.equal(messageSpacingMs(30), 31_500)
  assert.equal(messageSpacingMs(), 31_500)
  assert.equal(messageSpacingMs(0), 1000)
  assert.throws(() => validateMessage(''), /empty/)
  assert.throws(() => validateMessage('x'.repeat(201)), /at most 200/)
  // Code points, not UTF-16 units: 200 emoji is still 200 characters.
  assert.doesNotThrow(() => validateMessage('🎉'.repeat(200)))
})

test('send posts as the viewer for 50 units and returns id + sentAt; delete removes it', async () => {
  const { fake, ledger, bot, cleanup } = await setup()
  try {
    const sent = await bot.send('smoke-live-chat', 'hello from the lab')
    assert.match(sent.id, /^smoke-chat-/)
    assert.equal(sent.sentAt, NOW.toISOString())
    const message = fake.chat.messages.find((entry) => entry.id === sent.id)
    assert.equal(message.authorDetails.displayName, 'lab_viewer')
    assert.equal(message.snippet.displayMessage, 'hello from the lab')
    assert.deepEqual(fake.chat.sent, [], 'a viewer insert is not a streamer send')
    const insert = fake.requests.find((entry) => entry.method === 'POST')
    assert.equal(insert.query.part, 'snippet')

    const deleted = await bot.delete(sent.id)
    assert.deepEqual(deleted, { id: sent.id, deletedAt: NOW.toISOString() })
    assert.deepEqual(fake.chat.deleted, [sent.id])
    assert.equal(ledger.today().units, 100)
    assert.deepEqual(ledger.today().calls, {
      'liveChatMessages.insert': { calls: 1, units: 50 },
      'liveChatMessages.delete': { calls: 1, units: 50 }
    })
  } finally {
    await cleanup()
  }
})

test('runScript sends all 14 spaced for slow mode, then deletes the plain message', async () => {
  const { fake, ledger, bot, sleeps, cleanup } = await setup()
  try {
    const result = await bot.runScript('smoke-live-chat', { tag: 'run-7' })
    assert.equal(result.sent.length, 14)
    assert.equal(result.spacingMs, 31_500)
    assert.deepEqual(sleeps, Array(13).fill(31_500))
    assert.equal(result.deleted.id, result.sent[0].id)
    assert.deepEqual(fake.chat.deleted, [result.sent[0].id])
    assert.equal(ledger.today().units, scriptCost('run-7'))

    const fast = await bot.runScript('smoke-live-chat', { tag: 'run-8', slowModeSeconds: 0 })
    assert.equal(fast.spacingMs, 1000)
  } finally {
    await cleanup()
  }
})

test('runScript stops early on abort and a refused charge never sends', async () => {
  const { fake, bot, cleanup } = await setup({ maxUnitsPerDay: 120 })
  try {
    const controller = new AbortController()
    controller.abort()
    const aborted = await bot.runScript('smoke-live-chat', { signal: controller.signal })
    assert.deepEqual([aborted.sent, aborted.deleted], [[], null])

    await bot.send('smoke-live-chat', 'one')
    await bot.send('smoke-live-chat', 'two')
    const posts = () => fake.requests.filter((entry) => entry.method === 'POST').length
    assert.equal(posts(), 2)
    await assert.rejects(bot.send('smoke-live-chat', 'three'), QuotaRefused)
    assert.equal(posts(), 2)
  } finally {
    await cleanup()
  }
})

test('API errors surface with Google reason', async () => {
  const { fake, bot, cleanup } = await setup()
  try {
    fake.controls.deleteFailure = 'forbidden'
    await assert.rejects(bot.delete('smoke-chat-1'), (error) => {
      assert.equal(error.status, 403)
      assert.equal(error.reason, 'insufficientPermissions')
      assert.ok(!error.message.includes(VIEWER_TOKEN))
      return true
    })
  } finally {
    await cleanup()
  }
})
