# Plan 063: Kick as a supported streaming platform, connected over OAuth

> Executor: implement the ordered slices below in an isolated worktree of
> current main. Read `AGENTS.md` and `.claude/skills/videorc-design/SKILL.md`
> first. S0 is owner setup on kick.com and gates everything after S1. The
> reference change for "add a platform end to end" is commit `e46bb2b1`
> (TikTok + Instagram, #121); the reference provider for "OAuth + stream key
> + chat + viewers + metadata" is Twitch. Planning authorizes no merge or
> release.

## Status and decisions

- Status: EXECUTED 2026-09-25 on `feat/kick-platform` (S1-S6; web S4 in
  videorc-web PR #44). Dark: no Kick credentials are bundled yet. Owed:
  S0 redirect registration and credentials, S7 release env + website
  sweep, the live Kick smoke and the S3 acceptance stream. Not blocked by
  any third party: Kick apps are
  self-serve (2FA on the account, a redirect URL, accept the developer
  terms). No review before other users can authorize.
- Priority: P2 (user request, strategic reach). Effort: L across two repos
  (desktop M-L, web S-M). Risk: medium; new provider code paths, one new
  webhook relay on videorc-web.
- Planned against desktop origin/main `b2dba422` (2026-09-25 15:46 CEST)
  and videorc-web origin/main `4c20e519`. Line references below were read
  from those commits; the working tree on `feat/windows-owner-waiver` is
  stale.
- Owner route: Implementation (fit 8) for S1-S6, UI/Product Design (fit 9)
  for S3 card/icon/copy, Diagnose for S0's redirect-URI check. Model lanes:
  S2/S4/S5 `fable-5` (OAuth and relay correctness, live-critical), S1/S6
  `gpt-5.5`, S3 `opus-4.8`.
- Branches: desktop `feat/kick-platform`, web `feat/kick-chat-relay`.
  Commit prefix `feat(kick):`. Web ships first (webhook must exist before
  the desktop subscribes).
- Owner direction (2026-09-25): "Someone asked that we add kick.com…
  it doesn't cost us much to make it with oauth. Make a proper plan to
  connect [kick].com together with OAuth and to have it as a new streaming
  platform that is supported by Videorc."

### Decisions (the recommendation is taken)

1. **Kick is a first-class horizontal destination** with id and platform
   `kick`, label "Kick", both auth modes (OAuth default when connected,
   Manual RTMP always available), one more FLV copy of the horizontal
   encode. No vertical Kick target: Kick has no vertical format.
2. **OAuth from day one**, scopes `user:read channel:read channel:write
   chat:write streamkey:read events:subscribe`. No optional-scope dance;
   Kick has no audience scopes worth splitting out today.
3. **Chat reads through a videorc-web relay**, mirroring the X lane
   (`docs/x-chat.md` in videorc-web). Kick delivers chat only by webhook to
   one public URL configured per app, so the desktop cannot terminate it.
   Chat sends go direct from the desktop with the user token.
4. **Viewer count and stream state come from Kick's own channel read**
   (`GET /public/v1/channels` with no params returns the caller's channel
   including `stream.viewer_count` and `stream.is_live`). No webhook needed
   for numbers.
5. **Metadata: title and category**, through `PATCH /public/v1/channels`
   (`stream_title`, `category_id`, `custom_tags`). Category search through
   `GET /public/v2/categories`. Same accordion as Twitch, same
   "platform settings always apply, custom title optional" rule from plan
   059.
6. **Kick's client secret is bundled like Google's**, build-injected,
   fingerprint-only in logs and docs. Kick's token endpoint takes
   `client_secret` alongside the PKCE verifier.
7. **Ship dark behind provider readiness, not a feature flag.** With no
   client id baked in, the card shows the Manual RTMP badge and the existing
   "credentials not ready" message, exactly as Twitch did before its id was
   bundled. The release that bakes `VIDEORC_BUNDLED_KICK_CLIENT_ID` turns
   OAuth on.
8. **Bot identity is out**: messages send as the user (`type: "user"`).
   Kick's bot type is a separate concept and Orcle replies today are the
   streamer's voice everywhere else.

## Kick facts (verified 2026-09-25 against docs.kick.com and
`https://api.kick.com/swagger/doc.yaml`)

| Item | Fact |
| --- | --- |
| App creation | kick.com Account Settings, Developer tab; needs 2FA; yields client id, client secret, one redirect URL set, one webhook URL |
| Authorize | `GET https://id.kick.com/oauth/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256` |
| Token | `POST https://id.kick.com/oauth/token` with `grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`, `code`, `code_verifier`; refresh with `grant_type=refresh_token`; response has `expires_in`, `refresh_token`, `refresh_expires_in` (30 days in the example), `scope` |
| Revoke | `POST https://id.kick.com/oauth/revoke?token=…&token_hint_type=…` |
| Redirect note | docs say use `http://localhost/...` rather than `127.0.0.1` for local callbacks; our listener binds 127.0.0.1 on ports 17995/27995/37995 (`main.rs:3193`), so S0 must confirm which host Kick accepts |
| Profile | `GET https://api.kick.com/public/v1/users` (self) → `user_id`, `name`, `profile_picture`; `GET /public/v1/channels` (self) → `broadcaster_user_id`, `slug`, `stream_title`, `category{id,name,thumbnail}`, `stream{url,key,is_live,viewer_count,start_time,language,is_mature}` |
| Stream key | `stream.url` + `stream.key` from the channel read, scope `streamkey:read`. Public ingest today is `rtmps://fa723fc1b171.global-contribute.live-video.net:443/app`; always use the API's `stream.url` |
| Encoder limits | H.264 up to 1080p60, 1,000-8,000 kbps CBR, 2 s keyframes, 48 kHz stereo. Our non-YouTube cap (1080p / 6,000 kbps, `recording.rs:18225-18265`) already fits |
| Metadata | `PATCH /public/v1/channels` body `{stream_title?, category_id?, custom_tags?}`, scope `channel:write`, 204 |
| Categories | `GET /public/v2/categories` (search + pagination), `GET /public/v1/categories/{id}`; app or user token |
| Chat send | `POST /public/v1/chat` `{content, type:"user", broadcaster_user_id, reply_to_message_id?}`, scope `chat:write`, 500 graphemes and 2,048 UTF-8 bytes, 429 on limit |
| Chat read | webhooks only. `POST /public/v1/events/subscriptions` `{events:[{name,version}], method:"webhook"}` with a user token (scope `events:subscribe`, broadcaster inferred) or an app token plus `broadcaster_user_id`. `GET`/`DELETE` on the same path. Limit 1,000 `chat.message.sent` subscriptions per unverified app |
| Webhook security | headers `Kick-Event-Message-Id`, `Kick-Event-Subscription-Id`, `Kick-Event-Signature` (base64), `Kick-Event-Message-Timestamp`, `Kick-Event-Type`, `Kick-Event-Version`; signature = RSA PKCS1v15 SHA-256 over `"<message id>.<timestamp>.<raw body>"`; public key at `GET https://api.kick.com/public/v1/public-key`; a webhook failing for over a day is auto-unsubscribed |
| Events we use | `chat.message.sent` (sender `user_id`, `username`, `profile_picture`, `identity.username_color`, `identity.badges`, `content`, `emotes`, `created_at`, `replies_to`), `livestream.status.updated` (`is_live`, `title`, `started_at`, `ended_at`), `channel.followed` |
| Viewers | `stream.viewer_count` from the self channel read; or `GET /public/v1/users/livestreams?user_id=` (app token OK) → `viewer_count`, `started_at` |

Two facts are not verified and are owner/S0 work: whether the Kick redirect
allowlist accepts `http://127.0.0.1:<port>/oauth/callback`, and Kick's
avatar/emote CDN host for the avatar cache allowlist.

## Problem (measured on origin/main `b2dba422`)

### P1. Kick is reachable only as "Custom RTMP"

`STREAM_TARGET_DEFS` (`lib/capture.ts:514-546`) has no Kick entry, so a
Kick streamer pastes the ingest URL and key into the Custom card, gets no
logo, no chat, no viewers, no metadata, and no OBS-import detection
(`lib/obs-import-map.ts:154-162`).

### P2. `stream_platform_from_id` falls back to Custom

`streaming.rs:454-462` maps unknown ids to `Custom`. It is used when
loading `platform_accounts` (`storage.rs:5557`) and `live_chat_messages`
(`storage.rs:6376`). Adding `Kick` to the enum without this arm makes a
connected Kick account reload as a Custom account.

### P3. Per-platform plumbing is positional in places

`run_viewer_sampler(state, sid, youtube, twitch, x)` (`viewer_stats.rs:
373-430`) and `LiveChatStartParams { twitch, … }` (`live_chat.rs:1315`)
take one slot per platform. Kick adds a slot in each, and every caller
(`live_chat.rs:1592-1612`, `:1729`, `main.rs:3016-3121`).

### P4. Exhaustive maps that the compilers will flag

TypeScript `Record<StreamPlatform, …>`: `chat-platform-icon.tsx:23,32`,
`platform-glyph.tsx:15,26`, `lib/chat-send.ts:19`,
`lib/live-chat-view.ts:462`, `go-live-dialog.tsx:561-575`,
`streaming-tab.tsx:1785`, `lib/stream-metadata-summary.ts:16`,
`bridgeStreamingToLegacy` (`capture.ts:1971-1992`). Rust matches:
`live_chat.rs:456,1463`, `main.rs:3113`, `oauth.rs:47,587,2527,2812`,
`streaming.rs:448,553`, `preflight.rs:830`. The RPC contract's co-host
platform list `maxLength: 6` (`backend-rpc-contract.ts:1837`) must become 7.

### P5. No chat path exists without a public endpoint

Twitch chat is an EventSub WebSocket the desktop opens itself
(`twitch_chat.rs:34`). Kick offers only webhooks. The only existing relay
is the X lane (`x_chat.rs`, videorc-web `app/api/webhooks/x`,
`app/api/desktop/x-chat[/bind]`), keyed by X's HMAC scheme and OAuth Echo
identity proof. Kick needs its own signature verifier (RSA public key) and
its own identity proof (the desktop's Kick user token).

## Design

### Desktop: platform and destination

- `StreamPlatform::Kick` / `'kick'` everywhere listed in P4, plus
  `stream_platform_from_id` (P2). `RtmpPreset` gains `Kick`
  (`protocol.rs:1033`, `backend.ts:695`) so `rtmpDefaults.kick` can carry
  the public ingest and `bridgeStreamingToLegacy` stays exhaustive.
- `default_stream_targets()` (`streaming.rs:620-662`): Kick after Twitch in
  the horizontal group. `STREAM_TARGET_DEFS` and `STREAM_PLATFORM_ORDER`
  in the same position. `normalizeStreamingSettings` (`capture.ts:1853`)
  backfills the new def for existing installs by id; no migration.
- Icon: hand-written `KickIcon` SVG typed `AppIcon` in
  `components/icons.tsx` (Phosphor has none), colour tokens
  `--color-platform-kick` / `-ink` in `styles.css:378-381`, tints in
  `chat-platform-icon.tsx` and `platform-glyph.tsx`. `docs/icon-set.md`
  slot count goes from five brand marks to six. Eager budget is checked by
  `pnpm check:renderer-assets`.
- Key heuristics: `lib/stream-key-format.ts` Kick key shape (S0 records a
  redacted sample), `lib/obs-import-map.ts` detects `live-video.net` +
  "kick".
- Cap unchanged (`STREAMING_MAX_DESTINATIONS = 5`, `entitlements.rs:33`).
  Eight cards against a cap of five is fine; the cap message already says
  which ones to turn off.

### Desktop: OAuth

- `oauth.rs`: `BUNDLED_KICK_CLIENT_ID`, `BUNDLED_KICK_CLIENT_SECRET`
  (`option_env!`), runtime overrides `VIDEORC_KICK_CLIENT_ID` /
  `VIDEORC_KICK_CLIENT_SECRET`, `kick_finalization` mutex, a `Kick` arm in
  `provider_config` (`:2810-2865`) shaped like the X arm (`pkce: true`)
  with the id.kick.com URLs, scopes from Decision 2, and a client secret
  that is required (mirror `provider_credential_status` for YouTube,
  `secret_optional=false`). `parse_kick_profile` from `/public/v1/users`.
  `revoke_kick_token` on disconnect, next to YouTube's (`main.rs:10148`).
- Redirect: reuse the loopback listener. If S0 shows Kick rejects
  `127.0.0.1`, register `http://localhost:<port>/oauth/callback` and add a
  `localhost` host arm like Twitch's (`oauth.rs:2897`) for Kick only.
- `provider_credential_statuses` gains Kick; `scripts/lib/provider-
  readiness.mjs` gains a Kick entry with `secretRequired: true`;
  `scripts/lib/macos-release-artifact-validation.mjs` learns the bundled
  secret var must not leak in plain text.

### Desktop: Go Live

New `crates/videorc-backend/src/kick.rs`, shaped like `twitch.rs`:

- `prepare_kick_broadcast(account)`: `GET /public/v1/channels` (self),
  store `stream.key` at `platform:kick:{account}:stream-key`, return
  `PreparedKickBroadcast { server_url: stream.url, stream_key_secret_ref,
  redacted_url, broadcaster_user_id, slug }`. Never log the key.
- `apply_kick_channel_metadata(account, title?, category_id?)`: PATCH.
- `search_kick_categories(q)`: v2 endpoint, first 25.
- `effective_kick_metadata(draft)`: title from global or override, category
  from `kick_category_id/name` on `StreamTargetMetadataDraft`
  (`streaming.rs:300`, `backend.ts:844`), no language field.
- RPCs `streamTargets.kick.prepare|applyMetadata|searchCategories` in
  `main.rs` next to the Twitch trio (`:10476-10520`), with execution policy
  entries (`:4966`, `:5063`; a test enforces coverage). Renderer branch in
  `prepareOauthTargetsForGoLive` (`use-studio.tsx:12007-12025`) and the
  manual-mode metadata push loop (`:12095-12131`). No end-of-stream call.
- Manual mode: card prefilled with the public ingest, key pasted, no API.

### Desktop: chat, viewers, audience

- `kick_chat.rs`: sender (`POST /public/v1/chat`, 500 graphemes, 429 →
  backoff and a receipt error, mirroring `send_twitch_chat_message`
  receipts) and a relay reader modelled on `x_chat.rs` `RelayClient`
  (`:448-535`): bind, long-poll read with cursor, unbind; bearer is the
  Videorc session token from `crate::account::stored_session_token()`.
- Subscription lifecycle in the desktop, with the user token: at Go Live
  `POST /public/v1/events/subscriptions` for `chat.message.sent`,
  `livestream.status.updated`, `channel.followed`; store subscription ids
  in the account row's secrets namespace; `DELETE` them at stream end and
  on disconnect. Idempotent: `GET` first, reuse live ids.
- `live_chat.rs`: `chat_capability` Kick arm (read via relay, write direct,
  scopes `events:subscribe` / `chat:write`), `ChatSenderConfig::Kick`,
  `LiveChatStartParams.kick`, connector spawn and `register_sender`,
  `send_to_destination`, `fake_events` for the fake-providers smoke.
- Persistence: `live_chat_messages.platform = "kick"` round-trips once P2
  is fixed. Avatar cache allowlist (`main/avatar-cache.ts:12-29`) gains
  Kick's CDN host (S0 records it from a real `profile_picture` URL).
- Viewers: `viewer_stats.rs` gains `KickViewerConfig` + `fetch_kick_count`
  reading `stream.viewer_count` from the self channel read every sample;
  `run_viewer_sampler` takes a `kick` slot. Stream Manager
  `VIEWER_PLATFORMS` and status bar gain Kick.
- Audience: followers total is not in the channel read; `channel.followed`
  events give deltas. First version: follower delta from events only,
  `capability: "delta-only"` in the `stream-audience` row, honest note in
  `activity-pane.tsx:62-77`. No subscribers.

### Web: Kick chat relay (videorc-web)

Mirror of `docs/x-chat.md`, documented as `docs/kick-chat.md`:

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/webhooks/kick` | RSA signature over `id.timestamp.body` with Kick's public key (cached, refetched on verify failure once); reject on missing headers; dedupe on `Kick-Event-Message-Id` | store `chat.message.sent`, `livestream.status.updated`, `channel.followed` normalized rows keyed by `broadcaster.user_id` |
| `POST /api/desktop/kick-chat/bind` | desktop bearer; body `{ accessToken }`; server calls `GET /public/v1/users` with it to prove identity, stores `{ userId ↔ kickUserId }`; token is used once and not stored | binding |
| `DELETE /api/desktop/kick-chat/bind` | desktop bearer | forget |
| `GET /api/desktop/kick-chat?after=<cursor>&waitMs=20000` | desktop bearer | long-poll, `maxDuration = 30` |
| `GET /api/kick-chat/maintenance` | `CRON_SECRET` | 24 h prune, public-key refresh |

Tables `kick_chat_bindings`, `kick_chat_events` (migration next to
`0014_add_x_chat_relay.sql`), 24 h retention, only the fields needed to
render one comment row (author, avatar URL, colour, badges as strings,
content, emote ranges, created_at, reply-to id). The webhook URL registered
in the Kick app is `https://videorc.com/api/webhooks/kick`. One URL per
app: preview deployments cannot receive Kick events; test with
`scripts/kick-webhook.mjs` replaying signed fixtures (fixture key pair,
not Kick's).

### Copy and UI

- Destination card: "Kick" with the icon, "Connect Kick" in the OAuth
  panel, Manual RTMP with the ingest prefilled and one line "Stream key
  from kick.com → Creator Dashboard → Settings → Stream Key."
- Metadata accordion: title and category only. Category picker reuses the
  Twitch select pattern with Kick thumbnails hidden (no image budget).
- Comments: Kick tint and glyph; badge in highlights and caption overlay
  (`comment-highlight.ts:119-140`, `caption-overlay.ts:556-585`).
- Web marketing after the desktop ships: "6 platforms" sweep listed in
  S7. Never claim Windows Kick chat before it is proven there.

## Slices

### S0. Owner setup and redirect check (owner 30 min, agent 1 h)

1. Owner: enable 2FA on the Kick account, create app "Videorc" in the
   Developer tab, redirect URLs for the three loopback ports (try
   `http://127.0.0.1:17995/oauth/callback` first; if refused, the
   `localhost` form), webhook URL `https://videorc.com/api/webhooks/kick`.
   Put the client id and secret in `~/.videorc-release.env` as
   `VIDEORC_BUNDLED_KICK_CLIENT_ID` / `VIDEORC_BUNDLED_KICK_CLIENT_SECRET`
   (0600, backed up first, never printed).
2. Agent: a throwaway script in the scratchpad runs the PKCE flow with the
   runtime vars against the loopback listener contract, records: which
   redirect host Kick accepted, `refresh_expires_in`, the `profile_picture`
   host, a redacted stream key shape (length and charset only), and the
   category search response shape. Results go into this file under
   "S0 result".

Done when: "S0 result" block exists and the env file holds both vars.

### S1. Platform plumbing, dark (desktop)

Everything in P2, P4 and the "platform and destination" design: enum,
ids, labels, presets, defaults, `STREAM_TARGET_DEFS`, icon, colour tokens,
key format, OBS import, RPC contract `maxLength` 7, protocol fixtures,
`docs/icon-set.md`. Kick card visible with Manual RTMP only; OAuth panel
shows the credentials-not-ready message because no id is bundled yet.

Gates: `pnpm typecheck`, `pnpm lint`, `pnpm --filter @videorc/desktop
test`, `pnpm check:renderer-assets`, `cargo test -p videorc-backend
streaming`, `cargo clippy -p videorc-backend -- -D warnings`,
`pnpm smoke:multistream` with Kick manual added to the target list.

Done when: a Kick manual-key destination streams in the multistream smoke
and a reloaded account/message with platform `kick` does not become
Custom (unit test on `stream_platform_from_id`).

### S2. OAuth connect, profile, refresh, revoke (desktop)

`oauth.rs` per Design; `provider_credential_statuses`; readiness script;
release artifact validation; connect panel copy. Runtime-var by-eye connect
on the shipped app (`open -n -a Videorc --env …`, keeps TCC identity).

Gates: `cargo test -p videorc-backend oauth`, `pnpm smoke:oauth-guards`
(add Kick to the expected metadata rows at `scripts/smoke-oauth-guards-
app.mjs:81` and credential assertions), `pnpm smoke:provider-readiness`.

Done when: app shows Kick connected with handle and avatar, a forced
refresh succeeds, disconnect revokes and clears secrets.

### S3. Go Live over OAuth, metadata, categories (desktop)

`kick.rs` prepare/metadata/categories, RPCs, execution policy, renderer
prepare branch, metadata accordion with category search, summary helper,
preflight message matrix. Design lane owns the card, accordion, and copy.

Gates: `cargo test -p videorc-backend kick`, `streaming-metadata.test.ts`,
`stream-metadata-summary.test.ts`, `studio-provider.integration.test.ts`
mock cases, `pnpm smoke:oauth-guards`, and a real Go Live to Kick from the
dev build (owner channel, 5 minutes, title and category visible on
kick.com).

Done when: the acceptance stream shows on kick.com with the title and
category set by Videorc and the key was never typed by the owner.

### S4. Kick chat relay (web, ships before S5)

Routes, verifier, store, migration, maintenance cron in `vercel.json`,
`docs/kick-chat.md`, `scripts/kick-webhook.mjs`, tests `tests/kick-chat-
{relay,webhook,retention}.test.ts`. Env: none beyond `CRON_SECRET`; the
public key is fetched. Deploy to production so the webhook URL resolves
before any subscription is created.

Gates: web `pnpm test`, `pnpm lint` (note: web lint is broken on clean
main per memory; run the test suite and typecheck, record the lint state).

Done when: a signed fixture POST stores a row, an unsigned one is rejected
with 401, and the long-poll returns it to a bound desktop bearer.

### S5. Kick chat in the app (desktop)

`kick_chat.rs` sender + relay reader, subscription lifecycle, `live_chat.rs`
arms, avatar allowlist, comments UI tint/glyph/badges, fake-providers
smoke, Orcle sees Kick messages like any other platform.

Gates: `cargo test -p videorc-backend kick_chat live_chat`, `pnpm
smoke:live-chat-fake-providers`, `docs/live-chat-live-smoke-checklist.md`
gains a "Kick live smoke" section and it is run once for real (owner
channel: a viewer message arrives in the Comments window, a reply sent
from Videorc appears on kick.com, avatar renders).

Done when: the live smoke section is ticked with evidence and
subscriptions are deleted after the stream (verified by `GET
/public/v1/events/subscriptions` returning none for the app).

### S6. Viewers and audience (desktop)

`viewer_stats.rs` Kick fetch and sampler slot, Stream Manager viewer and
status rows, follower delta from `channel.followed`, provider facts doc.

Gates: `cargo test -p videorc-backend viewer_stats audience`, Stream
Manager unit tests, live check during the S5 smoke (count matches
kick.com within one sample).

Done when: Kick viewers appear in the stats bar and the `stream-audience`
row reports `delta-only` honestly.

### S7. Release and website

- Bake `VIDEORC_BUNDLED_KICK_CLIENT_ID` / `_SECRET` (release env from S0),
  `docs/distribution.md` env matrix and release blocker wording,
  `docs/oauth-live-smoke.md` Kick section, `docs/releases/<version>.md`
  internal record, public `changelog/<releaseId>.md` entry. macOS first;
  Windows follows only after the Kick manual and OAuth paths are run on a
  Windows box.
- Web copy sweep to six platforms: `lib/metadata.ts:21,25,78`,
  `lib/multistream-guide.ts`, `lib/og-image.tsx`, `lib/structured-data.ts`,
  `public/llms.txt`, `components/{features,pricing,app-showcase,faq}.tsx`,
  and the blog posts that count platforms. Same rule as plan 051: no
  Windows-specific multistream claims.

Done when: the shipped build connects Kick without runtime vars, the
website says six platforms, and the acceptance record exists under
`docs/acceptance/`.

## Execution notes (2026-09-25)

- Commits on `feat/kick-platform`: S1 `731d4f7f`, S2-S3 `a09497e9`,
  S5-S6 (this commit). Web relay: videorc-web `c522c46d`, PR #44.
- `stream_platform_from_id` was also missing tiktok and instagram arms;
  fixed in S1 with a round-trip test.
- `provider_credential_status` treated PKCE as a substitute for a required
  secret; fixed in S2 (X keeps `secret_optional=true`).
- Twitch's IVS ingest shares the `live-video.net` host, so OBS import
  detects Kick from the label or "kick" in the URL, not the host.
- Kick is a metadata platform (title + category, no language). Draft fields
  `kick_category_id/name` are `Option` with `skip_serializing_if`.
- Chat: subscriptions are created by the connector after the relay bind
  and deleted at session end and on disconnect; ids persist under
  `platform:kick:{account}:event-subscriptions`. Username colour and
  emote fragments are not mapped (model has no fields). Replies to a
  specific message are not sent (no field in `CommentsSendParams`).
- Audience: new `delta-only` capability; Kick shows new follows only.
- Release artifact validation only asserts the Kick secret is not in
  plain text in `app.asar`; a fail-closed "backend contains the pair"
  check like X's is S7 work once the release env has the values.
- Known-red gates on clean main too: two `cohost-pane-answered-on-air`
  tests and the local Mac gzip renderer budget (CI Linux is the gate).
- Owner still owes: the three `http://localhost:<port>/oauth/callback`
  redirect URLs on the Kick app, the bundled id/secret in the release env,
  and the Kick avatar CDN host confirmation (allowlist has `files.kick.com`).

## Out of scope

- Kick bot identity, channel points rewards, moderation, ads, KICKs.
- A vertical Kick leg.
- Twitch-style optional audience scopes for Kick.
- Kick clips or VOD import into the Library.
- Windows on-box proof in the first release.

## Risks and how the plan treats them

- **Redirect host.** If Kick refuses `127.0.0.1`, S2 adds the `localhost`
  host for Kick only. Nothing else depends on it.
- **Single webhook URL per app.** Preview deployments and local dev cannot
  receive Kick events. The replay script with a fixture key pair is the
  test path; the real path is proven in the S5 live smoke only.
- **Unverified-app subscription cap** of 1,000 `chat.message.sent`
  subscriptions per app. Subscriptions are deleted at stream end and on
  disconnect, and the maintenance cron reports the live count so we see
  the ceiling coming. Kick's verification process for larger apps is a
  follow-up if the count grows.
- **Token lifetime.** Refresh tokens expire (30 days in Kick's example).
  `validate_platform_accounts` already surfaces a reconnect state; copy
  must say "Reconnect Kick" rather than failing silently at Go Live.
- **Rate limits.** Chat send returns 429; the sender backs off and reports
  a receipt error like Twitch. Viewer sampling stays at the existing
  cadence; one channel read per sample is cheap.

## Verification summary

| Slice | Gates |
| --- | --- |
| S0 | Redirect and shape facts recorded in this file |
| S1 | typecheck, lint, desktop tests, renderer asset budget, `cargo test streaming`, clippy, `smoke:multistream` |
| S2 | `cargo test oauth`, `smoke:oauth-guards`, `smoke:provider-readiness`, by-eye connect |
| S3 | `cargo test kick`, metadata tests, integration mock cases, real Go Live to Kick |
| S4 | web tests + typecheck, signed/unsigned fixture POSTs, long-poll read |
| S5 | `cargo test kick_chat live_chat`, `smoke:live-chat-fake-providers`, live chat smoke with evidence |
| S6 | `cargo test viewer_stats audience`, Stream Manager tests, live count check |
| S7 | `pnpm smoke:local-gates`, `docs/oauth-live-smoke.md` Kick section on the shipped build, website sweep reviewed |

Per `AGENTS.md`, S1 and S3 touch recording output and are not done with
typecheck and lint alone; the multistream smoke and the real Go Live are
the closing gates.
