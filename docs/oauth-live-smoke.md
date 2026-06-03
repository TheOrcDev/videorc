# OAuth Live Smoke Runbook

Last official-docs check: 2026-06-03.

This runbook is the release acceptance path for first-class OAuth/native livestream destinations. It covers the external checks that local mocked smokes cannot prove: real OAuth login, platform metadata mutation, ingest readiness, and live start/stop behavior.

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

## Provider Prerequisites

Set the OAuth credentials in the environment used to launch the app or build the backend.

By default, OAuth uses the backend loopback callback at `http://127.0.0.1:<port>/oauth/callback`.
If a provider app registration supports desktop custom-scheme callbacks, launch Videorc with:

```sh
VIDEORC_OAUTH_CALLBACK_MODE=app-protocol
```

Then register `videorc://oauth/callback` as an allowed redirect URI for the provider app. The app-protocol path is opt-in so existing loopback provider registrations keep working.

YouTube:

```sh
VIDEORC_YOUTUBE_CLIENT_ID=...
VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID=...
VIDEORC_SMOKE_YOUTUBE_CHANNEL_READY=1
```

YouTube uses PKCE in Videorc, so `VIDEORC_YOUTUBE_CLIENT_SECRET` is optional. The test account must own or be able to select a verified Live-enabled channel.

Twitch:

```sh
VIDEORC_TWITCH_CLIENT_ID=...
VIDEORC_BUNDLED_TWITCH_CLIENT_ID=...
VIDEORC_TWITCH_CLIENT_SECRET=...
VIDEORC_SMOKE_TWITCH_ACCOUNT_READY=1
```

Twitch currently requires a runtime client secret because the app's Twitch OAuth provider config is not PKCE-only.

X:

```sh
VIDEORC_X_CLIENT_ID=...
VIDEORC_BUNDLED_X_CLIENT_ID=...
VIDEORC_SMOKE_X_NATIVE_LIVE_ACCESS=1
```

X uses PKCE in Videorc, so `VIDEORC_X_CLIENT_SECRET` is optional. The X native live check should only be marked ready when the release account has a validated partner/API path for native live source or broadcast creation. If that path is not available, leave the flag unset and keep X OAuth/native blocked in the app with explicit manual RTMP fallback.

## YouTube Acceptance

1. Launch the packaged release candidate with YouTube OAuth credentials.
2. Open Streaming and connect YouTube through OAuth.
3. Confirm the connected account identity appears and the credential source badge is `Bundled default` or the intended environment override.
4. Select the intended YouTube channel or brand channel.
5. Set global title and description. Use unlisted or private privacy for the test.
6. Enable the YouTube OAuth destination.
7. Confirm Studio's primary button says `Start Livestream` or `Start Livestream + Record`.
8. Click Start, review the Go Live confirmation, then confirm.
9. Verify YouTube Studio shows the expected title, description, privacy, and fresh broadcast.
10. Verify Videorc waits for active ingest before transitioning the broadcast live.
11. Verify video and audio arrive on YouTube.
12. Stop in Videorc and verify the YouTube broadcast transitions to complete.

Expected evidence:

- YouTube OAuth account screenshot.
- selected channel screenshot.
- Go Live confirmation screenshot.
- YouTube Studio screenshot showing matching metadata.
- final platform URL or broadcast ID.

## Twitch Acceptance

1. Launch the packaged release candidate with Twitch OAuth credentials and runtime client secret.
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

Current public X docs show Media Studio Producer support for RTMP/HLS sources and broadcasts, while the public X API overview does not expose a clear self-serve live-video source or broadcast creation endpoint. Videorc must not silently treat OAuth/native X as ready by falling back to manual RTMP.

If native partner/API access is available:

1. Record the partner/API path, required scopes, and account eligibility.
2. Launch the packaged release candidate with X OAuth credentials.
3. Connect X through OAuth.
4. Confirm `streamTargets.x.capability` reports native live availability.
5. Set title and description.
6. Enable the X OAuth destination.
7. Start through the Go Live confirmation.
8. Verify the native X broadcast/source uses the expected metadata.
9. Verify video and audio arrive on X.
10. Stop in Videorc and verify the X broadcast/source ends where supported.

If native access is not available:

1. Leave `VIDEORC_SMOKE_X_NATIVE_LIVE_ACCESS` unset.
2. Verify X OAuth/native readiness remains blocked with the partner/API explanation.
3. Verify manual RTMP is still available only when explicitly selected by the user.
4. Record the release as externally blocked for first-class X native live.

## Evidence Template

```md
## OAuth Live Smoke - YYYY-MM-DD - COMMIT

- Build: packaged macOS release candidate
- Commit:
- Runner:
- Provider readiness: pass/fail, redacted output attached
- YouTube: pass/fail, channel, broadcast ID/URL, notes
- Twitch: pass/fail, channel URL, notes
- X: pass/fail/blocked, partner/API evidence, notes
- Local smokes: pass/fail
- Screenshots/logs:
```

## Official Docs Checked

- [YouTube Live Streaming API overview](https://developers.google.com/youtube/v3/live/getting-started)
- [YouTube liveBroadcasts.transition](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition)
- [Twitch API Reference](https://dev.twitch.tv/docs/api/reference/)
- [Twitch Authentication](https://dev.twitch.tv/docs/authentication/)
- [X API Overview](https://docs.x.com/x-api/overview)
- [X Media Studio Producer](https://help.x.com/en/using-x/how-to-use-live-producer)
