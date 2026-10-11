import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

// Plan 176 L0. Loopback OAuth (RFC 8252) against the lab Google project's
// Desktop client: 127.0.0.1 on a random port, PKCE S256, offline access.

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const CHANNELS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/channels'

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function pkceChallenge(verifier) {
  return base64Url(createHash('sha256').update(verifier).digest())
}

export function createPkcePair() {
  const verifier = base64Url(randomBytes(32))
  return { verifier, challenge: pkceChallenge(verifier) }
}

export function createState() {
  return base64Url(randomBytes(16))
}

export function buildAuthUrl({ clientId, redirectUri, challenge, state }) {
  const url = new URL(AUTH_ENDPOINT)
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPE,
    access_type: 'offline',
    // select_account lets the owner pick the channel account or the personal
    // (viewer) account; consent forces a fresh refresh token every time.
    prompt: 'consent select_account',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state
  }).toString()
  return url.toString()
}

// Reads ?code / ?error from the loopback redirect. Pure, so it is testable.
export function parseCallback(requestUrl, expectedState) {
  const url = new URL(requestUrl, 'http://127.0.0.1')
  if (url.pathname !== '/') {
    return { ignore: true }
  }
  const error = url.searchParams.get('error')
  if (error) {
    return { error: `Google returned "${error}". Consent was not given.` }
  }
  const code = url.searchParams.get('code')
  if (!code) {
    return { ignore: true }
  }
  if (url.searchParams.get('state') !== expectedState) {
    return { error: 'The consent reply had the wrong state. Rerun live:hookup.' }
  }
  return { code }
}

const DONE_PAGE = (message) =>
  `<!doctype html><meta charset="utf-8"><title>Videorc live lab</title><body style="font:16px system-ui;padding:40px">${message}</body>`

export async function startLoopback({ state, timeoutMs = 5 * 60 * 1000 }) {
  let settle
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  const server = createServer((request, response) => {
    const parsed = parseCallback(request.url ?? '/', state)
    if (parsed.ignore) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (parsed.error) {
      response.end(DONE_PAGE('Consent failed. Go back to the terminal.'))
      settle.reject(new Error(parsed.error))
    } else {
      response.end(DONE_PAGE('Done. You can close this tab and go back to the terminal.'))
      settle.resolve(parsed.code)
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const timer = setTimeout(
    () => settle.reject(new Error(`No consent within ${Math.round(timeoutMs / 1000)} s.`)),
    timeoutMs
  )
  const close = () => {
    clearTimeout(timer)
    server.close()
    server.closeAllConnections?.()
  }
  return {
    redirectUri: `http://127.0.0.1:${server.address().port}`,
    code: result.finally(close),
    close
  }
}

async function postToken(body, fetchImpl) {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const reason = payload.error_description ?? payload.error ?? `HTTP ${response.status}`
    const error = new Error(`Google token endpoint: ${reason}`)
    error.code = payload.error
    throw error
  }
  return payload
}

export async function exchangeCode({
  clientId,
  clientSecret,
  code,
  verifier,
  redirectUri,
  fetchImpl = fetch
}) {
  const payload = await postToken(
    {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    },
    fetchImpl
  )
  if (!payload.refresh_token) {
    throw new Error('Google returned no refresh token. Rerun live:hookup for this role.')
  }
  const scopes = String(payload.scope ?? '').split(' ')
  if (!scopes.includes(YOUTUBE_SCOPE)) {
    throw new Error(
      `The account did not grant ${YOUTUBE_SCOPE}. Check the lab project's Data Access and test users.`
    )
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    scope: payload.scope
  }
}

export async function refreshAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch
}) {
  const payload = await postToken(
    {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    },
    fetchImpl
  )
  return payload.access_token
}

// channels.list mine=true, part=snippet: 1 quota unit.
export async function fetchMyChannel({ accessToken, fetchImpl = fetch }) {
  const url = new URL(CHANNELS_ENDPOINT)
  url.search = new URLSearchParams({ part: 'snippet', mine: 'true' }).toString()
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      `channels.list: ${payload.error?.message ?? `HTTP ${response.status}`}`.slice(0, 300)
    )
  }
  const channel = payload.items?.[0]
  if (!channel) {
    throw new Error('This Google account has no YouTube channel.')
  }
  return {
    channelId: channel.id,
    channelTitle: channel.snippet?.title ?? null,
    channelHandle: channel.snippet?.customUrl ?? null
  }
}
