import assert from 'node:assert/strict'
import test from 'node:test'

import { createYoutubeClient } from './youtube-api.mjs'

function fakeLedger() {
  const charged = []
  return { charged, charge: (method) => charged.push(method) }
}

function fakeFetch(statuses) {
  const sent = []
  return {
    sent,
    fetch: async (url, init) => {
      sent.push({ path: new URL(url).pathname, authorization: init.headers.authorization })
      const status = statuses.shift() ?? 200
      return { status, ok: status < 400, json: async () => ({ items: [] }) }
    }
  }
}

test('a role with no token is never charged: nothing went out', async () => {
  const ledger = fakeLedger()
  const { sent, fetch } = fakeFetch([])
  const client = createYoutubeClient({
    getToken: async (role) => {
      throw new Error(`The ${role} role is not authorized. Run pnpm live:hookup --role ${role}.`)
    },
    ledger,
    fetch
  })
  await assert.rejects(
    client.call({ role: 'broadcaster', method: 'liveStreams.list', resource: 'liveStreams' }),
    /broadcaster role is not authorized/
  )
  assert.deepEqual(ledger.charged, [])
  assert.deepEqual(sent, [])
})

test('a sent call is charged once, and its 401 retry with a fresh token is not charged again', async () => {
  const ledger = fakeLedger()
  const { sent, fetch } = fakeFetch([401, 200])
  const asked = []
  const client = createYoutubeClient({
    getToken: async (role, { force }) => (asked.push(force), force ? 'fresh' : 'cached'),
    ledger,
    fetch
  })
  assert.deepEqual(
    await client.call({ role: 'broadcaster', method: 'liveStreams.list', resource: 'liveStreams' }),
    { items: [] }
  )
  assert.deepEqual(ledger.charged, ['liveStreams.list'])
  assert.deepEqual(asked, [false, true])
  assert.deepEqual(
    sent.map((entry) => entry.authorization),
    ['Bearer cached', 'Bearer fresh']
  )
})

test('a refused charge never sends', async () => {
  const { sent, fetch } = fakeFetch([])
  const client = createYoutubeClient({
    getToken: async () => 'token',
    ledger: {
      charge: () => {
        throw new Error('quota refused')
      }
    },
    fetch
  })
  await assert.rejects(
    client.call({ role: 'broadcaster', method: 'liveStreams.list', resource: 'liveStreams' }),
    /quota refused/
  )
  assert.deepEqual(sent, [])
})
