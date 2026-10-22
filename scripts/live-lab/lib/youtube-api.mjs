// Plan 178 U8. The one way lab code talks to the YouTube Data API: charge the
// quota ledger first (a refused charge never sends), then call with the
// role's access token. `apiBase` points at Google in a run and at
// scripts/lib/fake-youtube-api.mjs in tests. Errors carry Google's reason but
// never the token or the request URL's query.

export const YOUTUBE_API_BASE = 'https://www.googleapis.com'

export class YoutubeApiError extends Error {
  constructor({ method, status, reason, message }) {
    super(`${method}: ${message ?? reason ?? `HTTP ${status}`}`.slice(0, 300))
    this.name = 'YoutubeApiError'
    this.method = method
    this.status = status
    this.reason = reason ?? null
  }
}

function resourcePath(resource) {
  return `/youtube/v3/${resource}`
}

/**
 * @param {object} options
 * @param {(role: string, opts?: {force?: boolean}) => Promise<string>} options.getToken
 * @param {{charge: (method: string, n?: number) => unknown}} options.ledger
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.apiBase]
 */
export function createYoutubeClient({ getToken, ledger, fetch: fetchImpl = fetch, apiBase }) {
  if (typeof getToken !== 'function') throw new Error('createYoutubeClient needs getToken(role).')
  if (!ledger?.charge) throw new Error('createYoutubeClient needs a quota ledger.')
  const base = String(apiBase ?? YOUTUBE_API_BASE).replace(/\/+$/, '')

  async function send({ role, method, httpMethod, resource, query, body }) {
    const url = new URL(`${base}${resourcePath(resource)}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
    let attempt = 0
    for (;;) {
      const token = await getToken(role, { force: attempt > 0 })
      const response = await fetchImpl(url, {
        method: httpMethod,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      })
      // One retry with a fresh token on 401 (a revoked or expired cache).
      // The retry is not charged again: Google bills auth failures at most
      // the original call's cost and the ledger already holds it.
      if (response.status === 401 && attempt === 0) {
        attempt += 1
        continue
      }
      if (response.status === 204) return null
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        const first = payload?.error?.errors?.[0]
        throw new YoutubeApiError({
          method,
          status: response.status,
          reason: first?.reason,
          message: payload?.error?.message
        })
      }
      return payload
    }
  }

  return {
    /**
     * @param {{role: string, method: string, httpMethod?: string, resource: string,
     *   query?: object, body?: object}} request
     */
    async call({ role, method, httpMethod = 'GET', resource, query, body }) {
      ledger.charge(method)
      return send({ role, method, httpMethod, resource, query, body })
    }
  }
}
