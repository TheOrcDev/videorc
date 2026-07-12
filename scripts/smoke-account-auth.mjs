#!/usr/bin/env node
// Legacy compatibility smoke for pre-PKCE desktop releases: exchange a one-time token for a
// session token, then validate it with a Bearer-authed get-session against a
// local (or configured) videorc-web. This needs a live server + a real OTT, so
// it is a manual dev tool, not a CI gate (it exits 0 / "skipped" without a token).
//
// Usage:
//   1. Run videorc-web locally (pnpm dev -> http://localhost:3000) and sign in.
//   2. Open <base>/desktop/authorize, click Authorize, and copy the legacy token from
//      the videorc://account/callback?token=... deep-link.
//   3. VIDEORC_TEST_OTT=<token> pnpm smoke:account-auth
//
// Env: VIDEORC_API_BASE_URL (default http://localhost:3000), VIDEORC_TEST_OTT.

const baseUrl = (process.env.VIDEORC_API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const oneTimeToken = process.env.VIDEORC_TEST_OTT ?? process.argv[2]

if (!oneTimeToken) {
  console.log(
    [
      'smoke:account-auth: skipped — no legacy one-time token.',
      `  1. Run videorc-web locally and sign in at ${baseUrl}/desktop/authorize.`,
      '  2. Click Authorize and copy the token from the',
      '     videorc://account/callback?token=... deep-link.',
      '  3. VIDEORC_TEST_OTT=<token> pnpm smoke:account-auth'
    ].join('\n')
  )
  process.exit(0)
}

function fail(message) {
  console.error(`smoke:account-auth FAILED: ${message}`)
  process.exit(1)
}

let verifyResponse
try {
  verifyResponse = await fetch(`${baseUrl}/api/auth/one-time-token/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: oneTimeToken })
  })
} catch (error) {
  fail(`could not reach ${baseUrl}: ${error.message}`)
}

if (!verifyResponse.ok) {
  fail(`one-time-token/verify returned ${verifyResponse.status} (expired or already-used token?)`)
}

const verified = await verifyResponse.json()
const sessionToken = verified?.session?.token
if (!sessionToken) {
  fail('verify response did not include session.token')
}
console.log(
  `[ok] exchanged one-time token -> session token (user: ${verified?.user?.email ?? '?'})`
)

let sessionResponse
try {
  sessionResponse = await fetch(`${baseUrl}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${sessionToken}` }
  })
} catch (error) {
  fail(`get-session request failed: ${error.message}`)
}

if (!sessionResponse.ok) {
  fail(`Bearer-authed get-session returned ${sessionResponse.status}`)
}

const session = await sessionResponse.json()
if (!session?.user?.email) {
  fail('Bearer-authed get-session did not return a user (token not accepted by the bearer plugin)')
}
console.log(`[ok] Bearer token authenticated get-session (user: ${session.user.email})`)
console.log('smoke:account-auth PASS')
