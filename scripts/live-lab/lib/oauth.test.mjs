import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import test from 'node:test'

import {
  ACCESS_TOKEN_REUSE_MS,
  YOUTUBE_SCOPE,
  buildAuthUrl,
  createAccessTokenSource,
  createPkcePair,
  exchangeCode,
  fetchMyChannel,
  parseCallback,
  pkceChallenge,
  refreshAccessToken,
  startLoopback
} from './oauth.mjs'

const CLIENT_ID = '123456789012-abcdef0123456789.apps.googleusercontent.com'

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function loopbackGet(url) {
  return new Promise((resolve, reject) => {
    request(url, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
      .on('error', reject)
      .end()
  })
}

test('PKCE challenge is the S256 of the verifier (RFC 7636 example)', () => {
  assert.equal(
    pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  )
  const pair = createPkcePair()
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(pair.challenge, createHash('sha256').update(pair.verifier).digest('base64url'))
})

test('buildAuthUrl asks for offline force-ssl consent with PKCE and account choice', () => {
  const url = new URL(
    buildAuthUrl({
      clientId: CLIENT_ID,
      redirectUri: 'http://127.0.0.1:5555',
      challenge: 'chal',
      state: 'st'
    })
  )
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  const params = Object.fromEntries(url.searchParams)
  assert.deepEqual(params, {
    client_id: CLIENT_ID,
    redirect_uri: 'http://127.0.0.1:5555',
    response_type: 'code',
    scope: YOUTUBE_SCOPE,
    access_type: 'offline',
    prompt: 'consent select_account',
    code_challenge: 'chal',
    code_challenge_method: 'S256',
    state: 'st'
  })
})

test('parseCallback returns the code, refuses a wrong state and surfaces denial', () => {
  assert.deepEqual(parseCallback('/?code=abc&state=s1', 's1'), { code: 'abc' })
  assert.match(parseCallback('/?code=abc&state=evil', 's1').error, /wrong state/)
  assert.match(parseCallback('/?error=access_denied&state=s1', 's1').error, /access_denied/)
  assert.deepEqual(parseCallback('/favicon.ico', 's1'), { ignore: true })
  assert.deepEqual(parseCallback('/', 's1'), { ignore: true })
})

test('startLoopback listens on 127.0.0.1 and resolves the code', async () => {
  const loopback = await startLoopback({ state: 's1', timeoutMs: 5000 })
  assert.match(loopback.redirectUri, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(await loopbackGet(`${loopback.redirectUri}/favicon.ico`), 404)
  assert.equal(await loopbackGet(`${loopback.redirectUri}/?code=the-code&state=s1`), 200)
  assert.equal(await loopback.code, 'the-code')
})

test('startLoopback rejects a denied consent and times out', async () => {
  const denied = await startLoopback({ state: 's1', timeoutMs: 5000 })
  const deniedResult = assert.rejects(denied.code, /access_denied/)
  await loopbackGet(`${denied.redirectUri}/?error=access_denied`)
  await deniedResult

  const slow = await startLoopback({ state: 's1', timeoutMs: 20 })
  await assert.rejects(slow.code, /No consent within/)
})

test('exchangeCode posts the PKCE verifier and requires a refresh token and the scope', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, body: Object.fromEntries(new URLSearchParams(init.body)) }
    return jsonResponse(200, {
      access_token: 'ya29.a',
      refresh_token: '1//refresh',
      scope: `${YOUTUBE_SCOPE} openid`
    })
  }
  const tokens = await exchangeCode({
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    code: 'c',
    verifier: 'v',
    redirectUri: 'http://127.0.0.1:1',
    fetchImpl
  })
  assert.equal(seen.url, 'https://oauth2.googleapis.com/token')
  assert.deepEqual(seen.body, {
    client_id: CLIENT_ID,
    client_secret: 'secret',
    code: 'c',
    code_verifier: 'v',
    grant_type: 'authorization_code',
    redirect_uri: 'http://127.0.0.1:1'
  })
  assert.equal(tokens.refreshToken, '1//refresh')

  await assert.rejects(
    exchangeCode({
      clientId: CLIENT_ID,
      clientSecret: 's',
      code: 'c',
      verifier: 'v',
      redirectUri: 'r',
      fetchImpl: async () => jsonResponse(200, { access_token: 'a', scope: YOUTUBE_SCOPE })
    }),
    /no refresh token/
  )
  await assert.rejects(
    exchangeCode({
      clientId: CLIENT_ID,
      clientSecret: 's',
      code: 'c',
      verifier: 'v',
      redirectUri: 'r',
      fetchImpl: async () =>
        jsonResponse(200, { access_token: 'a', refresh_token: 'r', scope: 'openid' })
    }),
    /did not grant/
  )
})

test('refreshAccessToken surfaces invalid_grant with its code', async () => {
  const fetchImpl = async () =>
    jsonResponse(400, {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.'
    })
  await assert.rejects(
    refreshAccessToken({ clientId: CLIENT_ID, clientSecret: 's', refreshToken: 'r', fetchImpl }),
    (error) => error.code === 'invalid_grant' && /expired or revoked/.test(error.message)
  )
  const ok = await refreshAccessToken({
    clientId: CLIENT_ID,
    clientSecret: 's',
    refreshToken: 'r',
    fetchImpl: async () => jsonResponse(200, { access_token: 'ya29.fresh' })
  })
  assert.equal(ok, 'ya29.fresh')
})

test('fetchMyChannel reads id, title and handle, and fails on no channel', async () => {
  let seen
  const channel = await fetchMyChannel({
    accessToken: 'ya29.a',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), auth: init.headers.authorization }
      return jsonResponse(200, {
        items: [{ id: 'UC1', snippet: { title: 'Videorc', customUrl: '@videorcapp' } }]
      })
    }
  })
  assert.equal(seen.url, 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true')
  assert.equal(seen.auth, 'Bearer ya29.a')
  assert.deepEqual(channel, {
    channelId: 'UC1',
    channelTitle: 'Videorc',
    channelHandle: '@videorcapp'
  })
  await assert.rejects(
    fetchMyChannel({ accessToken: 'a', fetchImpl: async () => jsonResponse(200, { items: [] }) }),
    /no YouTube channel/
  )
  await assert.rejects(
    fetchMyChannel({
      accessToken: 'a',
      fetchImpl: async () => jsonResponse(403, { error: { message: 'quotaExceeded' } })
    }),
    /quotaExceeded/
  )
})

test('access token source refreshes per role on the lab client, caches, and forces on demand', async () => {
  const calls = []
  let clock = 1_000
  const fetchImpl = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body))
    calls.push({ url: String(url), body })
    return jsonResponse(200, { access_token: `access-for-${body.refresh_token}-${calls.length}` })
  }
  const config = {
    client: { id: CLIENT_ID, secret: 'lab-client-secret-value' },
    roles: {
      broadcaster: { refreshToken: 'refresh-broadcaster-token' },
      viewer: { refreshToken: 'refresh-viewer-token-abc' }
    }
  }
  const getAccessToken = createAccessTokenSource({
    config,
    fetchImpl,
    tokenEndpoint: 'http://127.0.0.1:9/token',
    now: () => clock
  })
  assert.equal(await getAccessToken('broadcaster'), 'access-for-refresh-broadcaster-token-1')
  assert.equal(await getAccessToken('broadcaster'), 'access-for-refresh-broadcaster-token-1')
  assert.equal(await getAccessToken('viewer'), 'access-for-refresh-viewer-token-abc-2')
  assert.equal(calls[0].url, 'http://127.0.0.1:9/token')
  assert.deepEqual(calls[0].body, {
    client_id: CLIENT_ID,
    client_secret: 'lab-client-secret-value',
    refresh_token: 'refresh-broadcaster-token',
    grant_type: 'refresh_token'
  })
  assert.equal(
    await getAccessToken('broadcaster', { force: true }),
    'access-for-refresh-broadcaster-token-3'
  )
  clock += ACCESS_TOKEN_REUSE_MS
  assert.equal(await getAccessToken('viewer'), 'access-for-refresh-viewer-token-abc-4')

  await assert.rejects(
    createAccessTokenSource({ config: { ...config, roles: {} }, fetchImpl })('viewer'),
    /viewer role is not authorized/
  )
  await assert.rejects(
    createAccessTokenSource({ config: { ...config, client: null }, fetchImpl })('viewer'),
    /No lab OAuth client/
  )
})
