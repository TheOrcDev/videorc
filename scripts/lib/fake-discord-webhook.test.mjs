import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FAKE_CHANNEL_ID,
  FAKE_GUILD_ID,
  FAKE_WEBHOOK_NAME,
  buttonLabels,
  multipartFileName,
  parseBody,
  startFakeDiscord
} from './fake-discord-webhook.mjs'

test('answers like Discord and records what it was sent', async () => {
  const fake = await startFakeDiscord({ webhooks: [{ webhookId: '123', token: 'tok' }] })
  try {
    const base = `${fake.origin}/api/v10/webhooks/123/tok`
    const info = await (await fetch(base)).json()
    assert.equal(info.name, FAKE_WEBHOOK_NAME)
    assert.equal(info.channel_id, FAKE_CHANNEL_ID)
    assert.equal(info.guild_id, FAKE_GUILD_ID)

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
    assert.equal(announcements[0].webhookId, '123')
    assert.equal(announcements[1].body.content, 'Was live')

    const unknown = await fetch(`${fake.origin}/api/v10/webhooks/999/nope`)
    assert.equal(unknown.status, 404)
    assert.equal(fake.requests.at(-1).webhookId, null)
  } finally {
    await fake.close()
  }
})

test('serves several webhooks, each its own server, scripted apart', async () => {
  const fake = await startFakeDiscord({
    webhooks: [
      { webhookId: '1', token: 'a', name: 'Alerts' },
      { webhookId: '2', token: 'b', name: 'Crew' }
    ]
  })
  try {
    const [alerts, crew] = fake.webhooks
    assert.equal(alerts.name, 'Alerts')
    assert.equal(crew.name, 'Crew')
    assert.notEqual(alerts.channelId, crew.channelId)
    assert.notEqual(alerts.guildId, crew.guildId)
    assert.ok(!JSON.stringify(fake.webhooks).includes('"token"'))

    const base = (webhook) =>
      `${fake.origin}/api/v10/webhooks/${webhook.webhookId}/${webhook.webhookId === '1' ? 'a' : 'b'}`
    const crewInfo = await (await fetch(base(crew))).json()
    assert.equal(crewInfo.name, 'Crew')
    assert.equal(crewInfo.channel_id, crew.channelId)

    // A scripted refusal for one webhook never touches the other.
    fake.script('POST', 404, { message: 'Unknown Webhook', code: 10015 }, { webhookId: '1' })
    const crewPost = await fetch(`${base(crew)}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Live now' })
    })
    assert.equal(crewPost.status, 200)
    assert.equal((await crewPost.json()).channel_id, crew.channelId)
    const alertsPost = await fetch(`${base(alerts)}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Live now' })
    })
    assert.equal(alertsPost.status, 404)
    const alertsAgain = await fetch(`${base(alerts)}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Live now' })
    })
    assert.equal(alertsAgain.status, 200, 'the script was one answer')

    assert.equal(fake.announcements().length, 3)
    assert.equal(fake.announcements('1').length, 2)
    assert.equal(fake.announcements('2').length, 1)
    assert.equal(fake.announcements('2')[0].webhookId, '2')
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
