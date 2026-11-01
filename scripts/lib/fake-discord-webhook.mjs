import { createServer } from 'node:http'

// A local stand-in for Discord's webhook API (plan 187, smoke:discord-announce).
// The dev backend reaches it through the dev-only VIDEORC_DISCORD_API_BASE_URL;
// packaged builds refuse that override. It serves several webhooks (one per
// server), records every request (method, path, query, the JSON body or the
// multipart `payload_json`, and which webhook it hit) and answers like
// Discord: GET returns the webhook, POST ?wait=true the created message, PATCH
// the edited one. `script(method, status, body, { webhookId })` queues one
// scripted answer, for one webhook or for whichever comes next.

export const FAKE_WEBHOOK_NAME = 'Smoke alerts'
export const FAKE_CHANNEL_ID = '555000000000000001'
export const FAKE_GUILD_ID = '777000000000000001'

/**
 * `webhooks`: `[{ webhookId, token, name?, channelId?, guildId? }]`. Each
 * gets its own channel and server unless given, so "View in Discord" links
 * tell them apart.
 */
export async function startFakeDiscord({ webhooks }) {
  if (!Array.isArray(webhooks) || webhooks.length === 0) {
    throw new Error('startFakeDiscord needs at least one webhook.')
  }
  const served = webhooks.map((webhook, index) => ({
    webhookId: webhook.webhookId,
    token: webhook.token,
    name: webhook.name ?? (index === 0 ? FAKE_WEBHOOK_NAME : `${FAKE_WEBHOOK_NAME} ${index + 1}`),
    channelId: webhook.channelId ?? String(BigInt(FAKE_CHANNEL_ID) + BigInt(index)),
    guildId: webhook.guildId ?? String(BigInt(FAKE_GUILD_ID) + BigInt(index)),
    base: `/api/v10/webhooks/${webhook.webhookId}/${webhook.token}`
  }))
  const requests = []
  const scripted = []
  let nextMessageId = 1_000_000_000_000_000n

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const raw = Buffer.concat(chunks)
      const contentType = String(req.headers['content-type'] ?? '')
      const webhook = served.find((entry) => url.pathname.startsWith(entry.base)) ?? null
      const record = {
        method: req.method,
        path: url.pathname,
        query: url.search.replace(/^\?/, ''),
        contentType,
        body: parseBody(contentType, raw),
        attachment: multipartFileName(contentType, raw),
        webhookId: webhook?.webhookId ?? null,
        at: Date.now()
      }
      requests.push(record)

      const index = scripted.findIndex(
        (entry) =>
          entry.method === req.method &&
          (entry.webhookId === undefined || entry.webhookId === record.webhookId)
      )
      if (index !== -1) {
        const [entry] = scripted.splice(index, 1)
        return reply(res, entry.status, entry.body)
      }
      if (!webhook) {
        return reply(res, 404, { message: 'Unknown Webhook', code: 10015 })
      }
      const rest = url.pathname.slice(webhook.base.length)
      if (req.method === 'GET' && rest === '') {
        return reply(res, 200, {
          id: webhook.webhookId,
          type: 1,
          name: webhook.name,
          channel_id: webhook.channelId,
          guild_id: webhook.guildId
        })
      }
      if (req.method === 'POST' && rest === '') {
        nextMessageId += 1n
        return reply(res, 200, {
          id: String(nextMessageId),
          channel_id: webhook.channelId,
          webhook_id: webhook.webhookId,
          content: record.body?.content ?? ''
        })
      }
      const edit = /^\/messages\/(\d+)$/.exec(rest)
      if (req.method === 'PATCH' && edit) {
        return reply(res, 200, { id: edit[1], channel_id: webhook.channelId })
      }
      return reply(res, 405, { message: '405: Method Not Allowed', code: 0 })
    })
  })

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    /** The webhooks as served: ids, names, channels and servers (never the tokens). */
    webhooks: served.map(({ webhookId, name, channelId, guildId }) => ({
      webhookId,
      name,
      channelId,
      guildId
    })),
    /** Queues one answer for the next `method`, on `webhookId` or on any webhook. */
    script(method, status, body, { webhookId } = {}) {
      scripted.push({ method, status, body, webhookId })
    },
    /**
     * Posts and edits only (the verify GET is setup, not an announcement),
     * for one webhook or for all.
     */
    announcements(webhookId) {
      return requests.filter(
        (request) =>
          (request.method === 'POST' || request.method === 'PATCH') &&
          (webhookId === undefined || request.webhookId === webhookId)
      )
    },
    close() {
      return new Promise((resolveClose) => server.close(() => resolveClose()))
    }
  }
}

function reply(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text)
  })
  res.end(text)
}

/** The JSON a request carried: the body itself, or a multipart `payload_json`. */
export function parseBody(contentType, raw) {
  const text = raw.toString('utf8')
  if (!text) return null
  if (contentType.startsWith('multipart/form-data')) {
    const match = /name="payload_json"\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)\r?\n--/.exec(text)
    return match ? safeJson(match[1]) : null
  }
  return safeJson(text)
}

/** The uploaded file's name in a multipart post, if any. */
export function multipartFileName(contentType, raw) {
  if (!contentType.startsWith('multipart/form-data')) return null
  const match = /name="files\[0\]"; filename="([^"]+)"/.exec(raw.toString('latin1'))
  return match ? match[1] : null
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The labels of a body's link buttons, in order. */
export function buttonLabels(body) {
  return (body?.components ?? []).flatMap((row) =>
    (row.components ?? []).map((button) => button.label)
  )
}
