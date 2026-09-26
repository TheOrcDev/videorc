// OAuth credentials a public desktop build compiles into the Rust backend
// (`option_env!` in crates/videorc-backend/src/oauth.rs). The macOS release
// reads them from ~/.videorc-release.env on the release Mac; the Windows and
// Linux alpha candidates build in GitHub Actions and read repository secrets
// of the same names. A build without them ships with sign-in dead: Windows
// users saw "Twitch OAuth requires VIDEORC_TWITCH_CLIENT_ID." in place of
// Connect because no workflow ever passed these values, so the release
// preflights fail closed on each one.

import { isPlaceholderCredential } from './provider-readiness.mjs'

export const RELEASE_BUNDLED_OAUTH_ENV = [
  // Twitch: public client, device-code flow, id only.
  'VIDEORC_BUNDLED_TWITCH_CLIENT_ID',
  // Kick: the token exchange needs the secret even with PKCE (plan 063).
  'VIDEORC_BUNDLED_KICK_CLIENT_ID',
  'VIDEORC_BUNDLED_KICK_CLIENT_SECRET',
  // Native X Live signs every request with OAuth 1.0a (consumer pair).
  'VIDEORC_BUNDLED_X_OAUTH1_CONSUMER_KEY',
  'VIDEORC_BUNDLED_X_OAUTH1_CONSUMER_SECRET'
]

// Baked when set, for parity with macOS, but not required: YouTube OAuth is
// paused until Google approves the scope. VIDEORC_BUNDLED_X_CLIENT_ID is
// deliberately absent: X OAuth 2.0 uses the public client id written into
// oauth.rs, and an unset GitHub secret expands to "" rather than nothing.
export const RELEASE_OPTIONAL_BUNDLED_OAUTH_ENV = [
  'VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID',
  'VIDEORC_BUNDLED_YOUTUBE_CLIENT_SECRET'
]

/** One preflight check per required credential. Never includes a value. */
export function releaseBundledOauthChecks(env = process.env) {
  return RELEASE_BUNDLED_OAUTH_ENV.map((name) => {
    const value = typeof env[name] === 'string' ? env[name].trim() : ''
    const placeholder = isPlaceholderCredential(value)
    return {
      id: `bundled-oauth-${name}`,
      label: `${name} baked into the backend`,
      ok: value.length > 0 && !placeholder,
      detail: placeholder
        ? 'template text, not a real credential'
        : 'missing: set the repository secret of the same name (Windows and Linux) or ~/.videorc-release.env (macOS)'
    }
  })
}
