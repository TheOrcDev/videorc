import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FAKE_WEBHOOK_NAME,
  buttonLabels,
  multipartFileName,
  parseBody,
  startFakeDiscord
} from './fake-discord-webhook.mjs'

test('answers like Discord and records what it was sent', async () => {
  const fake = await startFakeDiscord({ webhookId: '123', token: 'tok' })
  try {
    const base = `${fake.origin}/api/v10/webhooks/123/tok`
    const info = await (await fetch(base)).json()
    assert.equal(info.name, FAKE_WEBHOOK_NAME)

    const posted = await fetch(`${base}?wait=true&with_components=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Live now: Smoke',
        components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Twitch', url: 'x' }] }]
      })
    })
    const message = await posted.json()
    assert.match(message.id, /^\d+$/)

    const edited = await fetch(`${base}/messages/${message.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Was live' })
    })
    assert.equal(edited.status, 200)

    fake.script('POST', 404, { message: 'Unknown Webhook', code: 10015 })
    const gone = await fetch(`${base}?wait=true`, { method: 'POST', body: '{}' })
    assert.equal(gone.status, 404)

    const announcements = fake.announcements()
    assert.equal(announcements.length, 3)
    assert.deepEqual(buttonLabels(announcements[0].body), ['Twitch'])
    assert.equal(announcements[0].query, 'wait=true&with_components=true')
    assert.equal(announcements[1].body.content, 'Was live')
  } finally {
    await fake.close()
  }
})

test('reads the payload and file name of a multipart post', () => {
  const boundary = 'b0undary'
  const raw = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="payload_json"',
      '',
      '{"content":"hi","attachments":[{"id":0,"filename":"thumbnail.png"}]}',
      `--${boundary}`,
      'Content-Disposition: form-data; name="files[0]"; filename="thumbnail.png"',
      'Content-Type: image/png',
      '',
      'PNG',
      `--${boundary}--`,
      ''
    ].join('\r\n')
  )
  const type = `multipart/form-data; boundary=${boundary}`
  assert.equal(parseBody(type, raw).content, 'hi')
  assert.equal(multipartFileName(type, raw), 'thumbnail.png')
})
