import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'

import { resolveFakeApiRoute, startFakeApiRouter } from './fake-api-router.mjs'

describe('fake API router', () => {
  it('resolves the longest matching prefix, ignoring the query string', () => {
    const routes = [
      { prefix: '/api/ai/', origin: 'http://ai' },
      { prefix: '/api/ai/captions/', origin: 'http://captions' },
      { prefix: 42, origin: 'http://ignored' }
    ]
    assert.equal(resolveFakeApiRoute('/api/ai/captions/chunks?x=1', routes), 'http://captions')
    assert.equal(resolveFakeApiRoute('/api/ai/cohost/tick', routes), 'http://ai')
    assert.equal(resolveFakeApiRoute('/health', routes), null)
    assert.equal(resolveFakeApiRoute('/health', routes, 'http://fallback'), 'http://fallback')
  })

  it('streams method, path, headers, body and status through to the chosen fake', async () => {
    const seen = []
    const upstream = createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8')
        })
        res.writeHead(207, { 'content-type': 'application/json', 'retry-after': '9' })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise((resolveListen) => upstream.listen(0, '127.0.0.1', resolveListen))
    const origin = `http://127.0.0.1:${upstream.address().port}`
    const router = await startFakeApiRouter({ routes: [{ prefix: '/api/ai/cohost/', origin }] })
    try {
      const response = await fetch(`${router.httpOrigin}/api/ai/cohost/tick?probe=1`, {
        method: 'POST',
        headers: { authorization: 'Bearer smoke-token', 'content-type': 'application/json' },
        body: JSON.stringify({ tickSeq: 1 })
      })
      assert.equal(response.status, 207)
      assert.equal(response.headers.get('retry-after'), '9')
      assert.deepEqual(await response.json(), { ok: true })
      assert.deepEqual(seen, [
        {
          method: 'POST',
          url: '/api/ai/cohost/tick?probe=1',
          authorization: 'Bearer smoke-token',
          body: '{"tickSeq":1}'
        }
      ])

      const unrouted = await fetch(`${router.httpOrigin}/api/ai/captions/chunks`, {
        method: 'POST',
        body: 'ignored'
      })
      assert.equal(unrouted.status, 404)
      assert.equal((await unrouted.json()).error.code, 'not-found')
      assert.deepEqual(router.state, { forwarded: 1, unrouted: 1 })
    } finally {
      await router.close()
      await new Promise((resolveClose) => upstream.close(resolveClose))
    }
  })
})
