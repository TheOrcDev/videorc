# OAuth Live Smoke Runbook

Last official-docs check: 2026-07-07.

This runbook is the release acceptance path for first-class OAuth/native livestream destinations. It covers the external checks that local mocked smokes cannot prove: real OAuth login, platform metadata mutation, ingest readiness, and live start/stop behavior.

## Provider Assumptions Checked 2026-07-07

- **YouTube:** Public builds keep OAuth/native Live Streaming API support paused
  until Google approves the app. A verification candidate can explicitly enable
  the complete flow so reviewers can exercise consent, channel selection,
  broadcast management, chat, and revocation before approval.
- **Twitch:** The developer app must register the OAuth redirect URL(s), and
  broadcaster actions use user access tokens with scoped permissions. The
  existing Videorc scopes still map to the current docs:
  `channel:manage:broadcast` for broadcast metadata and
  `channel:read:stream_key` for reading the stream key. Twitch still treats
  access tokens, refresh tokens, and client secrets as password-equivalent, so
  release evidence must never print their values.
- **X:** Videorc is allow-listed for the X Livestream API. Native source and
  broadcast management requires backend OAuth 1.0a user-context credentials,
  not the existing OAuth2 PKCE profile token. Videorc must prepare/reuse an X
  RTMPS source, wait for `is_stream_active`, publish the broadcast, and end it
  with a strict `{ "state": "END" }` body. Manual RTMP remains explicit user
  choice, not a hidden fallback.

## Local Gates First

Run these before spending time on real provider accounts:

```sh
pnpm smoke:local-gates
```

The aggregate command runs the non-packaged local gate set:

```sh
pnpm typecheck
pnpm build
cargo test -p videorc-backend
cargo clippy -p videorc-backend -- -D warnings
pnpm smoke:oauth
pnpm smoke:oauth-guards
pnpm smoke:sources
pnpm smoke:start-labels
pnpm smoke:streaming-secrets
pnpm smoke:platform-lifecycle
pnpm smoke:screens
pnpm smoke:multistream
pnpm smoke:dev
pnpm smoke:provider-readiness
```

After building a packaged release candidate, also run:

```sh
pnpm smoke:packaged:bundled
```

`pnpm smoke:provider-readiness` does not print credential values. By default it reports missing prerequisites without failing, so a local developer can run it without production credentials.

For release candidates, make missing prerequisites fail:

```sh
pnpm smoke:provider-readiness:strict
```

To generate a redacted markdown readiness report for the evidence template:

```sh
pnpm smoke:provider-readiness:evidence
```

## Provider Prerequisites

Set the OAuth credentials in the environment used to launch the app or build the backend.

OAuth uses the backend's dedicated loopback callback listener, bound to the first free
port of `17995`, `27995`, `37995`. Register ALL THREE callback URLs in every active
OAuth provider's developer portal so one busy port cannot break OAuth:

```text
http://127.0.0.1:17995/oauth/callback
http://127.0.0.1:27995/oauth/callback
http://127.0.0.1:37995/oauth/callback
```

**Twitch registers the `localhost` forms instead** — its console rejects every
non-HTTPS redirect except the literal `http://localhost` ("Redirect URIs must
use HTTPS protocol"), and the backend sends `localhost` for Twitch to match:

```text
http://localhost:17995/oauth/callback
http://localhost:27995/oauth/callback
http://localhost:37995/oauth/callback
```

Exact-match providers (X, Twitch) reject unregistered ports. If all three
candidates are busy the backend logs a warning and falls back to its dynamic
main port, which is not accepted by those exact-match providers.

After the fixed callback URLs are registered or otherwise verified for the
release provider apps, set this smoke flag:

```sh
VIDEORC_SMOKE_PROVIDER_CALLBACKS_READY=1
```

The readiness report prints the required callback URLs and the confirmation flag
only; it does not inspect provider portals or print private account details.

Readiness is advisory by default. For release-candidate QA, run it strict so
missing prerequisites FAIL instead of advising:

```sh
VIDEORC_SMOKE_REQUIRE_PROVIDER_READY=1
```

For X only, `VIDEORC_OAUTH_X_CALLBACK=app-protocol` restores the legacy
`videorc://oauth/callback` redirect. Avoid it: X auto-approves re-authorization
without a user gesture and browsers block gestureless custom-scheme navigation,
leaving x.com's consent page on an infinite spinner while the app never receives the
callback.

YouTube public releases remain paused until Google approval completes. To build
or run a reviewer candidate, enable the guarded path and provide the public
installed-app client ID (PKCE is used; no client secret is bundled):

```sh
VIDEORC_ENABLE_YOUTUBE_OAUTH=1
VIDEORC_YOUTUBE_CLIENT_ID=...
VIDEORC_SMOKE_YOUTUBE_CHANNEL_READY=1
```

For a packaged reviewer or approved release, compile with:

```sh
VIDEORC_BUNDLED_YOUTUBE_OAUTH_ENABLED=1
VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID=...
```

The Google app must register the three `127.0.0.1` callback URLs above. The
authorization requests only `youtube.force-ssl`, requests offline access with
PKCE, and Disconnect revokes the Google token before deleting local account
data. Leave both enable flags unset in public builds until approval.

Twitch:

```sh
VIDEORC_TWITCH_CLIENT_ID=...
VIDEORC_BUNDLED_TWITCH_CLIENT_ID=...
VIDEORC_TWITCH_CLIENT_SECRET=...
VIDEORC_SMOKE_TWITCH_ACCOUNT_READY=1
```

Register the Videorc Twitch application with **Client Type: Public** (dev
console) — public clients exchange and refresh tokens with the client id
alone, so no secret ships anywhere. `VIDEORC_TWITCH_CLIENT_SECRET` is only
for confidential setups (e.g. a fork running its own confidential app).

Twitch release blocker: a production candidate is not "out-of-the-box" ready until a
Videorc-owned PUBLIC Twitch developer app exists with the three loopback callback
URLs registered, and `VIDEORC_BUNDLED_TWITCH_CLIENT_ID` is injected at backend build
time (add it to `~/.videorc-release.env`). The backend already requests
`channel:manage:broadcast`, `channel:read:stream_key`, `user:read:chat`, and
`user:write:chat`.

X:

```sh
VIDEORC_X_CLIENT_ID=...
VIDEORC_BUNDLED_X_CLIENT_ID=...
VIDEORC_X_OAUTH1_CONSUMER_KEY=...
VIDEORC_X_OAUTH1_CONSUMER_SECRET=...
VIDEORC_X_OAUTH1_ACCESS_TOKEN=...
VIDEORC_X_OAUTH1_ACCESS_TOKEN_SECRET=...
VIDEORC_X_OAUTH1_USER_ID=...
VIDEORC_SMOKE_X_LIVESTREAM_OAUTH1_READY=1
VIDEORC_SMOKE_X_NATIVE_LIVE_ACCESS=1
```

The X developer app must register the three fixed loopback callback URLs listed above
(X matches redirect URIs exactly, port included) — the OAuth 1.0a "Authorize X
Live" flow and the OAuth2 profile flow share the same callback list. X uses PKCE
in Videorc, so `VIDEORC_X_CLIENT_SECRET` is optional for the existing OAuth2
profile flow. Native X Livestream source/broadcast management is separate: it
signs with OAuth 1.0a. End users mint their own token through Authorize X Live
(Streaming tab) against the consumer pair bundled into release builds; the
`VIDEORC_X_OAUTH1_ACCESS_TOKEN*` env values above are a smoke/self-host
override that bypasses the in-app flow. The native live check should only be
marked ready when the allow-listed app and broadcast account have validated
source, ingest, publish, end, and redacted-diagnostics behavior. If neither a
bundled consumer pair nor OAuth1 env credentials are configured, leave
`VIDEORC_SMOKE_X_LIVESTREAM_OAUTH1_READY` unset and keep X OAuth/native blocked
with explicit manual RTMP still available.

## YouTube Manual RTMP Acceptance

1. Launch the packaged release candidate without Google OAuth credentials.
2. Open Streaming and expand YouTube.
3. Confirm the auth mode is Manual RTMP and the OAuth pause message mentions Google approval.
4. Paste a YouTube RTMP stream key and save it.
5. Set global title and description in Videorc, then create/configure the YouTube live event in YouTube Studio.
6. Enable the YouTube destination.
7. Confirm Studio's primary button says `Start Livestream` or `Start Livestream + Record`.
8. Click Start, review the Go Live confirmation, then confirm.
9. Verify video and audio arrive on the manually configured YouTube event.
10. Stop in Videorc and end the event in YouTube Studio.

Expected evidence:

- YouTube Manual RTMP auth-mode screenshot showing the Google approval pause message.
- Go Live confirmation screenshot.
- YouTube Studio screenshot for the manually configured event.
- final platform URL or broadcast ID.

## Twitch Acceptance

1. Launch the packaged release candidate (bundled public-client Twitch id; no secret).
2. Open Streaming and connect Twitch through OAuth.
3. Confirm the connected account identity appears and Twitch reports ready credential state.
4. Search for and select a Twitch category.
5. Set title and language. Confirm the description field is not presented as a Twitch per-live field.
6. Enable the Twitch OAuth destination.
7. Confirm Studio's primary button says `Start Livestream` or `Start Livestream + Record`.
8. Click Start, review the Go Live confirmation, then confirm.
9. Verify the Twitch channel title, category, and language update before the stream starts.
10. Verify video and audio arrive on Twitch.
11. Stop in Videorc and verify the local session ends cleanly.

Expected evidence:

- Twitch OAuth account screenshot.
- category picker screenshot.
- Go Live confirmation screenshot.
- Twitch channel screenshot showing matching metadata.
- final stream URL or channel URL.

## X Acceptance

X native live now uses the allow-listed Livestream API path. Videorc must not
silently treat OAuth/native X failures as manual RTMP; the native destination
either prepares/publishes through the API or fails with diagnostics.

If native X Livestream API access is available:

1. Record that the X app is allow-listed and the account can broadcast.
2. Launch the packaged release candidate (consumer pair bundled at build time).
   Confirm `streamTargets.x.capability` reports `needs-authorization`, run
   Authorize X Live from the Streaming tab, and approve in the browser.
   (Smoke override: exporting the redacted `VIDEORC_X_OAUTH1_*` env values
   skips the browser flow.)
3. Confirm `streamTargets.x.capability` reports `ready`.
4. Set title and description.
5. Enable the X OAuth/native destination.
6. Start through the Go Live confirmation.
7. Verify Videorc prepares/reuses an X RTMPS source.
8. Verify X reports `is_stream_active` before broadcast creation.
9. Verify broadcast create and publish succeed, and the share URL opens.
10. Verify video and audio arrive on X.
11. Verify read-only X chat connects when chat is enabled and messages exist.
12. Stop in Videorc and verify X receives a strict END request and reports ended.

If native access is not available:

1. Leave `VIDEORC_SMOKE_X_NATIVE_LIVE_ACCESS` unset.
2. Verify X OAuth/native readiness remains blocked with the X Livestream API
   credential/access explanation.
3. Verify manual RTMP is still available only when explicitly selected by the user.
4. Record the release as externally blocked for first-class X native live.

## Evidence Template

```md
## OAuth Live Smoke - YYYY-MM-DD - COMMIT

- Build: packaged macOS release candidate
- Commit:
- Runner:
- Run context: dev/packaged
- Provider readiness: pass/fail, redacted output attached
- Provider readiness evidence: paste `pnpm smoke:provider-readiness:evidence` output
- YouTube Manual RTMP: pass/fail, channel, broadcast ID/URL, notes
- Twitch: pass/fail, channel URL, notes
- X: pass/fail/blocked, allow-list/OAuth1 evidence, broadcast URL, notes
- Local smokes: pass/fail
- Screenshots/logs:
```

## Official Docs Checked

- 2026-06-13:
  [YouTube Live Streaming API overview](https://developers.google.com/youtube/v3/live/getting-started),
  [YouTube Life of a Broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast),
  [YouTube liveBroadcasts](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts),
  [YouTube liveStreams](https://developers.google.com/youtube/v3/live/docs/liveStreams),
  [YouTube Help: Get started with live streaming](https://support.google.com/youtube/answer/2474026),
  [YouTube Help: Create a live stream with an encoder](https://support.google.com/youtube/answer/2907883),
  [Google OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app),
  [Twitch Authentication](https://dev.twitch.tv/docs/authentication/),
  [Twitch Register Your App](https://dev.twitch.tv/docs/authentication/register-app),
  [Twitch API Reference](https://dev.twitch.tv/docs/api/reference),
  [Twitch Access Token Scopes](https://dev.twitch.tv/docs/authentication/scopes/),
  [X API Overview](https://docs.x.com/x-api/overview),
  [X Media Studio Producer](https://help.x.com/en/using-x/how-to-use-live-producer)
