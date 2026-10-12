import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REDACTION_PATTERNS,
  RedactionFailed,
  assertPublishable,
  findSensitive,
  redactText,
  redactValue
} from './redact.mjs'

const SAMPLES = [
  ['youtube-stream-key', 'key abcd-1234-efgh-5678-ijkl here'],
  ['google-client-credential', 'GOCSPX-abcdefghijklmnop'],
  ['google-client-id', '123456789012-abcdefghijklmnopqrstuv.apps.googleusercontent.com'],
  ['google-refresh-credential', '1//0abcdefghijklmnopqrstuvwxyz1234'],
  ['credential-prefix', 'ya29.a0AfH6SMBxyz'],
  ['email', 'someone@example.com'],
  ['home-dir', '/Users/somebody/videorc-live-lab/runs'],
  ['stream-url', 'rtmps://a.rtmps.youtube.com:443/live2'],
  ['remote-credential', '{"token":"deadbeefcafe1234"}'],
  ['ws-credential-url', 'ws://127.0.0.1:1234/ws?token=abc123def456']
]

test('findSensitive names the pattern and never the text', () => {
  for (const [name, text] of SAMPLES) {
    const hits = findSensitive(`before ${text} after`)
    assert.ok(
      hits.some((hit) => hit.pattern === name),
      `${name}: ${JSON.stringify(hits.map((hit) => hit.pattern))}`
    )
    for (const hit of hits) assert.deepEqual(Object.keys(hit).sort(), ['index', 'pattern'])
  }
  assert.deepEqual(findSensitive('Run 2026-10-12-chat-a1b2c3 passed at 2026-10-12T06:00:00Z.'), [])
  assert.deepEqual(findSensitive(''), [])
})

test('redactText removes every hit, is idempotent and its labels are clean', () => {
  for (const [name, text] of SAMPLES) {
    const once = redactText(`x ${text} y`)
    assert.ok(once.includes(`[redacted:${name}]`), `${name}: ${once}`)
    assert.deepEqual(findSensitive(once), [], `${name} leaves no hit`)
    assert.equal(redactText(once), once, `${name} is idempotent`)
  }
  for (const { name } of REDACTION_PATTERNS) {
    assert.deepEqual(findSensitive(`[redacted:${name}]`), [], `label ${name} is not a hit`)
  }
})

test('redactValue walks objects and arrays', () => {
  const value = redactValue({
    summary: 'mail someone@example.com',
    list: ['ok', 'ya29.'],
    nested: { path: '/Users/x/y', n: 3, flag: true, none: null }
  })
  assert.deepEqual(value, {
    summary: 'mail [redacted:email]',
    list: ['ok', '[redacted:credential-prefix]'],
    nested: { path: '[redacted:home-dir]', n: 3, flag: true, none: null }
  })
})

test('assertPublishable fails closed on text files and skips binary ones', async () => {
  const files = {
    '/run/report.md': 'clean report\n',
    '/run/verdict.json': '{"summary":"has abcd-1234-efgh-5678-ijkl"}',
    '/run/charts/rss.png': 'GOCSPX-notreadbecausebinary'
  }
  const read = async (path) => files[path]
  await assertPublishable(['/run/report.md', '/run/charts/rss.png'], { read })
  await assert.rejects(
    assertPublishable(Object.keys(files), { read }),
    (error) =>
      error instanceof RedactionFailed &&
      error.code === 'REDACTION_FAILED' &&
      error.hits.every((hit) => hit.file === '/run/verdict.json') &&
      error.hits[0].pattern === 'youtube-stream-key' &&
      !error.message.includes('abcd-1234')
  )
})
