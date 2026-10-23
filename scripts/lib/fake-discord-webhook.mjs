import { createServer } from 'node:http'

// A local stand-in for Discord's webhook API (plan 187, smoke:discord-announce).
// The dev backend reaches it through the dev-only VIDEORC_DISCORD_API_BASE_URL;
// packaged builds refuse that override. It records every request (method,
// path, query, the JSON body or the multipart `payload_json`) and answers like
// Discord: GET returns the webhook, POST ?wait=true the created message, PATCH
// the edited one. `script(method, status, body)` queues one scripted answer.

export const FAKE_WEBHOOK_NAME = 'Smoke alerts'
export const FAKE_CHANNEL_ID = '555000000000000001'
export const FAKE_GUILD_ID = '777000000000000001'

export async function startFakeDiscord({ webhookId, token }) {
  const requests = []
  const scripted = []
  let nextMessageId = 1_000_000_000_000_000n
  const base = `/api/v10/webhooks/${webhookId}/${token}`

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const raw = Buffer.concat(chunks)
      const contentType = String(req.headers['content-type'] ?? '')
      const record = {
        method: req.method,
        path: url.pathname,
        query: url.search.replace(/^\?/, ''),
        contentType,
        body: parseBody(contentType, raw),
        attachment: multipartFileName(contentType, raw),
        at: Date.now()
      }
      requests.push(record)

      const index = scripted.findIndex((entry) => entry.method === req.method)
      if (index !== -1) {
        const [entry] = scripted.splice(index, 1)
        return reply(res, entry.status, entry.body)
      }
      if (!url.pathname.startsWith(base)) {
        return reply(res, 404, { message: 'Unknown Webhook', code: 10015 })
      }
      const rest = url.pathname.slice(base.length)
      if (req.method === 'GET' && rest === '') {
        return reply(res, 200, {
          id: webhookId,
          type: 1,
          name: FAKE_WEBHOOK_NAME,
          channel_id: FAKE_CHANNEL_ID,
          guild_id: FAKE_GUILD_ID
        })
      }
      if (req.method === 'POST' && rest === '') {
        nextMessageId += 1n
        return reply(res, 200, {
          id: String(nextMessageId),
          channel_id: FAKE_CHANNEL_ID,
          webhook_id: webhookId,
          content: record.body?.content ?? ''
        })
      }
      const edit = /^\/messages\/(\d+)$/.exec(rest)
      if (req.method === 'PATCH' && edit) {
        return reply(res, 200, { id: edit[1], channel_id: FAKE_CHANNEL_ID })
      }
      return reply(res, 405, { message: '405: Method Not Allowed', code: 0 })
    })
  })

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    script(method, status, body) {
      scripted.push({ method, status, body })
    },
    /** Posts and edits only (the verify GET is setup, not an announcement). */
    announcements() {
      return requests.filter((request) => request.method === 'POST' || request.method === 'PATCH')
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
