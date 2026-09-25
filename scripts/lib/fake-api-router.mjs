import { createServer, request as httpRequest } from 'node:http'

/**
 * One local origin in front of several fake Videorc services. A debug backend
 * has a single `VIDEORC_API_BASE_URL`, so a smoke that needs the fake co-host
 * (`/api/ai/cohost/*`) and the fake caption service (`/api/ai/captions/*`) at
 * once points the backend here. Requests are streamed through unchanged
 * (method, path, headers, body, status); nothing is logged, so bearer and
 * transcript material never leave the two fakes. WebSocket upgrades are not
 * proxied: the caption fake hands out its own realtime URL.
 */

/**
 * Pick the upstream origin for a request path (pure). The longest matching
 * prefix wins; `fallback` (or null) otherwise.
 */
export function resolveFakeApiRoute(url, routes, fallback = null) {
  const path = String(url ?? '').split('?')[0]
  let best = null
  for (const route of routes ?? []) {
    if (!route || typeof route.prefix !== 'string' || typeof route.origin !== 'string') continue
    if (!path.startsWith(route.prefix)) continue
    if (!best || route.prefix.length > best.prefix.length) best = route
  }
  return best ? best.origin : fallback
}

export async function startFakeApiRouter({ routes = [], fallback = null } = {}) {
  const state = { forwarded: 0, unrouted: 0 }
  const server = createServer((req, res) => {
    const origin = resolveFakeApiRoute(req.url, routes, fallback)
    if (!origin) {
      state.unrouted += 1
      req.resume()
      const body = JSON.stringify({
        error: { code: 'not-found', message: 'No fake service for this route.' }
      })
      res.writeHead(404, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      })
      res.end(body)
      return
    }
    state.forwarded += 1
    const upstream = httpRequest(new URL(req.url, origin), {
      method: req.method,
      headers: req.headers
    })
    upstream.on('response', (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy(error)
        return
      }
      const body = JSON.stringify({
        error: { code: 'fake-upstream-failed', message: error.message }
      })
      res.writeHead(502, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      })
      res.end(body)
    })
    req.pipe(upstream)
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  return {
    httpOrigin: `http://127.0.0.1:${address.port}`,
    state,
    close() {
      return new Promise((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      })
    }
  }
}
