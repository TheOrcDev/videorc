import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applySnapshot, applyStep, createCardState, sanitizeSnapshot } from './card-state.mjs'

// Plan 178 U7 (plan 176 L3, plan 166 S6). Serves the test card on 127.0.0.1
// and pushes the card state to it over SSE. The harness opens the URL in a
// kiosk browser on the lab display; Videorc captures that display.
//
//   const card = await startCardServer({ runInfo: { runId, scenario, appVersion, startedAt } })
//   card.push(snapshot)   // allowlisted metrics (card-state.mjs); the rest is dropped
//   card.setStep({ index: 3, total: 12, name: 'Scene applied', sceneId: 2 })
//   await card.close()

export const CARD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'card')
const HOST = '127.0.0.1'
const HEARTBEAT_MS = 15_000

const STATIC_FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/card.css': ['card.css', 'text/css; charset=utf-8'],
  '/card.js': ['card.js', 'text/javascript; charset=utf-8'],
  '/card-view.mjs': ['card-view.mjs', 'text/javascript; charset=utf-8'],
  '/marker-codec.mjs': ['marker-codec.mjs', 'text/javascript; charset=utf-8'],
  '/markers.json': ['markers.json', 'application/json; charset=utf-8']
})

// Nothing on the card loads from the network: the page is public on stream
// and must render the same with no internet.
const SECURITY_HEADERS = Object.freeze({
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store'
})

function sanitizePulse(body, now) {
  const count = Number.isInteger(body?.count) && body.count >= 0 ? body.count : null
  const audioState = ['running', 'suspended', 'closed'].includes(body?.audioState)
    ? body.audioState
    : 'unknown'
  const visible = body?.visible === 'visible' ? 'visible' : 'hidden'
  const at = Number.isFinite(body?.at) ? body.at : now
  return { count, audioState, visible, focused: body?.focused === true, at, receivedAt: now }
}

function readBody(request, limit = 2048) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectBody(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    request.on('error', rejectBody)
  })
}

/**
 * @param {{ port?: number, runInfo?: object, now?: () => number,
 *   onDropped?: (fields: string[]) => void, readStatic?: (name: string) => Promise<Buffer> }} [options]
 */
export async function startCardServer({
  port = 0,
  runInfo = {},
  now = Date.now,
  onDropped,
  readStatic = (name) => readFile(join(CARD_DIR, name))
} = {}) {
  let state = createCardState(runInfo)
  let lastPulse = null
  const clients = new Set()

  const broadcast = () => {
    const frame = `event: state\ndata: ${JSON.stringify(state)}\n\n`
    for (const response of clients) response.write(frame)
  }

  const server = createServer(async (request, response) => {
    const address = server.address()
    const allowedHosts = [`${HOST}:${address.port}`, `localhost:${address.port}`]
    if (!allowedHosts.includes(request.headers.host ?? '')) {
      response.writeHead(403, SECURITY_HEADERS).end()
      return
    }
    const path = new URL(request.url ?? '/', `http://${HOST}`).pathname

    if (request.method === 'GET' && path === '/events') {
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        connection: 'keep-alive'
      })
      response.write(`retry: 1000\nevent: state\ndata: ${JSON.stringify(state)}\n\n`)
      clients.add(response)
      request.on('close', () => clients.delete(response))
      return
    }

    if (request.method === 'POST' && path === '/pulse') {
      try {
        lastPulse = sanitizePulse(JSON.parse((await readBody(request)) || '{}'), now())
        response.writeHead(204, SECURITY_HEADERS).end()
      } catch {
        response.writeHead(400, SECURITY_HEADERS).end()
      }
      return
    }

    const file = STATIC_FILES[path]
    if (request.method === 'GET' && file) {
      try {
        const body = await readStatic(file[0])
        response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': file[1] }).end(body)
      } catch {
        response.writeHead(500, SECURITY_HEADERS).end()
      }
      return
    }
    response.writeHead(404, SECURITY_HEADERS).end()
  })

  const heartbeat = setInterval(() => {
    for (const response of clients) response.write(': keep-alive\n\n')
  }, HEARTBEAT_MS)
  heartbeat.unref()

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, HOST, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const { port: boundPort } = server.address()

  return {
    url: `http://${HOST}:${boundPort}/`,
    port: boundPort,
    /** Allowlisted metrics only; returns the names of dropped fields. */
    push(metricsSnapshot) {
      const { snapshot, dropped } = sanitizeSnapshot(metricsSnapshot, now())
      state = applySnapshot(state, snapshot)
      if (dropped.length) onDropped?.(dropped)
      broadcast()
      return { dropped }
    },
    setStep(step) {
      state = applyStep(state, step)
      broadcast()
      return state.step
    },
    state: () => state,
    /** The page's last sync pulse: proves the card is running and its audio is live. */
    lastPulse: () => lastPulse,
    clientCount: () => clients.size,
    async close() {
      clearInterval(heartbeat)
      for (const response of clients) response.end()
      clients.clear()
      const closed = new Promise((resolveClose) => server.close(() => resolveClose()))
      server.closeAllConnections()
      await closed
    }
  }
}
