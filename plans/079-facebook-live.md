# Plan 079: Facebook Live as a destination

**Status:** IN PROGRESS 2026-09-30. S1 implemented; local validation and owner live acceptance tracked in `docs/acceptance/2026-09-30-facebook-live.md`. S0 and S2–S6 remain blocked by Meta setup, live probe results and the owner sign-in choice.
**Priority:** P2 (new destination). **Size:** L, plus Meta's review time.
**Planned against:** `origin/main` `235d6014` (0.9.122 plus #500 and #501).
**Owner route:** Orchestrator, then Implementation per slice (fit 9).
**Model lanes:**

- `fable-5` for S2, S3 and S4 (sign-in, the broadcast lifecycle, comments),
  and for the S0 spikes.
- `opus-4.8` for the Setup and Go Live UI in S1 and S2. Read
  `.claude/skills/videorc-design/SKILL.md` first.
- `gpt-5.5` for the mechanical parts of S1 and for S5.
  **Repos:** `videorc` (desktop) and `videorc-web` (`~/projects/videorcweb`),
  the second only if S0 picks the web broker.

## Execution record (2026-09-30)

- S1: Facebook manual-key card, horizontal binding, secret-reference persistence,
  enum mirrors, derived contract caps, OBS import, brand styling, and Go Live
  publish reminder implemented. Release-note fetching and control load lazily
  to keep the existing eager asset budget.
- Web prerequisite: co-host accepts Facebook input and attribution in
  [videorc-web PR #60](https://github.com/TheOrcDev/videorc-web/pull/60).
  Production deployment is pending; deploy it before a Facebook desktop release.
- S0: no owner live probe results supplied; option A/B is undecided. Open
  questions are recorded in `docs/specs/stream-manager-provider-facts.md`.
- S2–S5: not implemented while the S0 sign-in and provider facts gates are open.
- S6: owner-led verification and Meta approval are outstanding; no public
  connected-mode switch, release, review screencast, or Facebook live is claimed.

## Goal

Facebook becomes a first-class destination, next to YouTube, Twitch, Kick and X:

- connect a Facebook Page once;
- Go Live creates the Page's live video with our title and description;
- comments are read and sent in the Stream Manager;
- viewers and followers show in the stats bar;
- Stop ends the live.

Until Meta approves the app, Facebook also works as a pasted stream key
destination with no API.

## Decisions

- **LinkedIn is out** (owner, 2026-09-30: "no linkedin, I don't like it").
  The research is kept here so nobody redoes it:
  - LinkedIn's Live Events API is partner-gated, with a development tier of
    100 calls a day and no committed review time.
  - Since 2026-06-22 every LinkedIn live must be a scheduled event.
  - Comments and live viewer counts are partner-only and undocumented.
  - It requires 16:9 at 1080p30 or less, 6 Mbps or less, and Baseline with
    no B-frames.
  - Its API terms forbid charging "incremental fees" for the integration.
- **Pages first.** The first version streams to Facebook Pages. Personal
  profiles (`publish_video`) are a follow-up:
  - a profile live defaults to the app's "Friends" visibility;
  - tools get no comments unless the user changes it to Public;
  - it doubles the App Review surface.

  Groups are impossible: Meta removed the Groups API on 2024-04-22.

- **Two modes, one destination card.**
  - **Stream key** works for everyone from S1, with no Meta dependency.
  - **Connected Page** is on for the owner and app testers as soon as S2
    lands, and for everyone after Meta approves the app (S6).
- **Landscape only.** Meta's spec is 16:9. A dual-orientation session sends
  the horizontal leg to Facebook, and the Facebook card is pinned horizontal.
- **No Premium gate.** Multistreaming is free, with a cap of 5 on every tier.

## What works today

A user can already reach Facebook through the one **Custom RTMP** card:
server `rtmps://rtmp-api.facebook.com:443/rtmp/` plus the key from Live
Producer ("Streaming software"). Our validation and redaction accept it.

What's missing:

- A named card, with its guidance and icon.
- Comments, viewers and metadata.
- A second custom destination: there is only one Custom card.

## Facebook facts (checked 2026-09-30, Graph API v26.0; sources at the end)

- **Create a live video.** `POST /{page_id}/live_videos` with a Page token
  whose user has `CREATE_CONTENT`.
  - Parameters: `status`, `title` (up to 254 characters), `description`,
    `enable_backup_ingest`, `stop_on_delete_stream`.
  - The response has `id` and `secure_stream_url`. The key is everything
    after `/rtmp/`; there is no separate key field.
  - The URL must be used within 24 h, and a live may run for up to 8 h.
- **Going public.** `LIVE_NOW` publishes the moment our encoder connects.
  The safe pattern:
  1. Create the live as `UNPUBLISHED`.
  2. Push.
  3. Wait for `ingest_streams`.
  4. `POST /{id}` with `status=LIVE_NOW`.

  An unused `UNPUBLISHED` object is deleted after several hours. End the
  live with `POST /{id}` and `end_live_video=true`, which leaves a VOD.
  Health data refreshes every 2 s.

- **Ingest.**
  - RTMPS only. Use the returned `secure_stream_url`; OBS's default server is
    `rtmps://rtmp-api.facebook.com:443/rtmp/`.
  - H.264 at Level 4.1 (1080p30) or 4.2 (1080p60), CBR, keyframe every 2 s.
  - AAC-LC at 44.1 or 48 kHz, 128 kbps preferred and 256 at most.
  - 1080p60 at 4.5–9 Mbps; nothing above 1080p.

  **Our stream encode already matches:** High with the level label, `-maxrate`
  equal to the bitrate, `-g` of fps × 2 with forced 2 s keys, AAC 48 kHz at
  160k (`recording.rs` ~l.12809–12830 and ~l.17446). The existing cap of
  1080p / 6,000 kbps for every platform except YouTube stays.

- **Who can go live.** The account must be at least 60 days old, and the Page
  (or a profile in professional mode) needs at least 100 followers.
  - The API refuses with subcode `1363120` (account age) or `1363144`
    (followers).
  - A new test Page can't go live, so the owner's own Page is the test Page.
- **Permissions (Pages):**
  - `pages_show_list`: list Pages with `/me/accounts`.
  - `pages_manage_posts` and `pages_read_engagement`: create a live video.
  - `pages_read_user_content`: read comments.
  - `pages_manage_engagement`: comment as the Page.
  - Plus the **Live Video API** feature.
  - All of these need App Review, Advanced Access (which needs Business
    Verification) and Access Verification (Tech Provider).
  - Before review, everything works for people with a role on the app. The
    owner and testers can build and dogfood now.
- **Tokens.**
  - The code exchange and the 60-day `fb_exchange_token` both need the app
    secret ("make this call from your server").
  - A Page token derived from a long-lived user token does not expire.
  - There are no refresh tokens: when a token dies (password change, role
    lost, app removed), the user logs in again.
  - Live mode requires HTTPS redirects with Strict Mode. Loopback `http` is
    allowed in development mode only (UNCONFIRMED).
  - **Login for Devices** (`/device/login` with `APP_ID|CLIENT_TOKEN`) needs
    no secret and gives a token of about 60 days. Whether it can grant
    `pages_*` permissions is UNCONFIRMED; S0 tests it.
- **Comments.**
  - `GET /{live_video_id}/comments` with `order=reverse_chronological` and
    `live_filter=no_filter`, polled every few seconds.
  - Or Server-Sent Events: `streaming-graph.facebook.com/{id}/live_comments`.
    It is in the current guide, but its parameter page is gone, so S0
    re-checks `comment_rate` and `fields`.
  - Each comment has `from{id,name}`, where `id` is a Page-scoped id.
    Commenter pictures need the Business Asset User Profile Access feature,
    which also needs review.
  - Post as the Page with `POST /{video.id}/comments` (the video id, not the
    live video id).
- **Viewers.** `live_views` is the instant count. Page followers come from
  `followers_count`. There are no follow events.
- **Rate limits.**
  - A Page token gets 4800 × engaged users per 24 h. A small Page has a small
    budget, so poll gently and read the `X-Business-Use-Case-Usage` header.
  - Errors 32 and 80001 mean the limit was hit.
- **Retention.** Lives created since 2025-02-19 are removed from Facebook
  after 30 days. Our local recording is the archive.

## The one decision the owner makes: how sign-in works

Meta's code exchange needs the app secret. The web privacy page promises that
connected-platform tokens "are never transmitted to or stored on our servers"
(`videorcweb/app/privacy/page.tsx` ~l.284). There are three options.

| Option                                            | How                                                                                                                                                                                                      | Privacy promise                               | UX                                                                                             | Risk                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **A. Login for Devices** (preferred if S0 passes) | The desktop calls `/device/login` with the app id and a client token (made to be embedded). The user approves a code at facebook.com/device. The desktop polls, then calls `/me/accounts` itself.        | Kept: no token touches our server             | The user types an 8-character code (Twitch shows it pre-filled)                                | Page permissions through device login are unconfirmed                            |
| **B. Web broker**                                 | videorc-web holds the secret. The HTTPS callback exchanges the code, gets the 60-day token, and hands it to the desktop's loopback through a sealed one-time code redeemed with PKCE. It stores nothing. | Must change to "passes through, never stored" | A normal browser login, like Restream and StreamYard                                           | A new public endpoint; privacy text; the deletion callback lives there anyway    |
| C. Bundle the secret in the app                   | Like Kick                                                                                                                                                                                                | Kept                                          | A normal login, but it needs an HTTPS redirect, so an embedded webview on `login_success.html` | Meta says not to; an extractable secret; webview login is fragile. **Rejected.** |

**Recommendation:** run the A spike in S0. If device login grants the Page
permissions, use A. It reuses the device-grant poller shape Twitch already has
(`oauth.rs` `start_twitch_device_grant`), and the privacy promise stands.
Otherwise use B, and change the privacy page in the same web PR. Both
options need the web data-deletion and deauthorize callbacks for App Review
(S2).

## Owner actions (Meta critical path, start now)

1. **Business Verification** for the Videorc business portfolio. It gates
   everything else and takes up to 14 business days.
2. **Create the Meta app** (Business type) in that portfolio.
   - Add Facebook Login (or Login for Business, whichever S0 settles on) and
     the **Live Video API** product.
   - For option A, also turn on "Login for Devices".
3. **App settings:**
   - privacy policy URL;
   - data-deletion callback `https://www.videorc.com/api/oauth/facebook/data-deletion`;
   - a 1024 px icon;
   - for option B, the redirect `https://www.videorc.com/api/oauth/facebook/callback`
     with Strict Mode.
4. **Add app roles** for the owner and testers, so the whole flow works in
   development mode before review.
5. **Hand over the IDs.**
   - The app id (and the client token for A) goes into
     `~/.videorc-release.env` and the GitHub release secrets.
   - The app secret goes to Vercel only (`FACEBOOK_APP_SECRET`, plus
     `OAUTH_BROKER_SEAL_KEY` for B).
   - Agents never read `.env` files.
6. **Eligibility:** confirm the owner's Page has at least 100 followers.
7. **After S5:** record the screencasts, submit App Review, then do Access
   Verification (S6).

Realistic time to public connected mode: **4 to 8 weeks**, set by Meta and
assuming at most one rejection. Engineering is about 2 weeks and runs in
parallel.

## Out of scope

- LinkedIn.
- Personal profiles, Groups and Events.
- Scheduled Facebook lives (`SCHEDULED_UNPUBLISHED` up to 7 days ahead; this
  belongs with plan 045's scheduled streams).
- Vertical and above-1080p Facebook output.
- Commenter avatars (Business Asset User Profile Access, a second review).
- Live reactions, Page webhooks and crossposting.
- Marketing copy about Facebook before S6.

## Slices

Order: S0 → S1 → S2 → S3 → S4 → S5 → S6.

- S1 ships on its own and doesn't wait for Meta.
- S2–S5 are for app-role users until S6 flips the switch.
- Each slice leaves the app working and ends with its own commit.
- Work in a dedicated worktree; other sessions switch branches in the shared
  checkout.

### S0: Meta app and facts (spikes, no product code)

The owner does the Meta setup above. An agent runs throwaway scripts from the
scratchpad (never committed), in the owner's shell whenever a token is
involved, against the owner's Page in development mode.

Answer these and record the answers in a new Facebook section of
`docs/specs/stream-manager-provider-facts.md`:

1. **Device login and Pages.** Does `/device/login` with
   `scope=pages_show_list,pages_manage_posts,pages_read_engagement,pages_read_user_content,pages_manage_engagement`
   succeed? Does `/me/accounts` then return Page tokens, and do they report
   `expires_at: 0` in `debug_token`? This decides between option A and B.
2. **Loopback in development mode.** Is `http://127.0.0.1:17995/oauth/callback`
   accepted as a redirect? This is for information only; live mode still
   needs HTTPS.
3. **SSE comments.** Does `streaming-graph.facebook.com/{id}/live_comments`
   stream during a live? Record which `comment_rate` values are accepted and
   which fields come back.
4. **Encoder drop tolerance.** During a `LIVE_NOW` test live, cut our push
   for 5, 15, 30 and 60 s. Record whether Facebook resumes or ends the live
   (status `VOD`). This decides what S3 does when the FFmpeg restart ladder
   reconnects.
5. **Our actual output.** Stream Videorc's 1080p30 and 1080p60 profiles at
   6 Mbps. Record what `ingest_streams{stream_health}` reports, and any
   warnings in `recommended_encoder_settings`.
6. **The Live Producer key flow** for S1's copy: the server URL shown, how
   the persistent key works, and whether the user must press Go live in the
   browser.

Done when the facts section is written and the owner has chosen option A or
B.

### S1: The Facebook platform and stream-key mode (ships alone)

Add `StreamPlatform::Facebook` (`facebook`) everywhere a platform is listed.
Its card has no chat, no metadata and no API: the key and URL are pasted.

- **Compiler-flagged sites (Rust):**
  - `streaming.rs` `stream_platform_id` and `stream_platform_label`.
  - `oauth.rs`: `provider_oauth_unavailable_message` (return "Connecting a
    Facebook Page isn't available yet" until S2),
    `lock_platform_finalization`, `parse_provider_profile`,
    `provider_config` (bail until S2).
  - `oauth_callback_page.rs` `platform_label`.
  - `live_chat.rs` `chat_capability`: Unsupported, with "Facebook comments
    need a connected Page".
  - `main.rs` `prepare_session_live_chat`.
- **Silent sites (no compiler help; add each and a test):**
  - `streaming.rs` `stream_platform_from_id`. Without it an unknown id
    reloads as `Custom`, the Kick P2 bug. Also `default_stream_targets`.
  - `live_chat.rs` `chat_capabilities` and `fake_events`.
  - `audience.rs` `reconnect_message` and `read_with_token`.
  - `main.rs` `session_audience_sources`.
  - `oauth.rs` redirect host.
  - The storage tests that assert exactly four accounts.
- **TypeScript mirrors:**
  - `shared/backend.ts` `StreamPlatform`.
  - `backend-rpc-contract.ts` `STREAM_PLATFORMS`.
  - `Record<StreamPlatform,…>` maps: `capture.ts` `STREAM_PLATFORM_LABELS`
    and `streamPlatformOutputCapabilities`; `live-chat-view.ts`
    `CHAT_PLATFORM_LABELS`; `chat-send.ts`; `chat-platform-icon.tsx`;
    `platform-glyph.tsx`; `go-live-dialog.tsx` `platformLabel`.
  - Lists: `capture.ts` `rtmpDefaults`, `STREAM_PLATFORM_ORDER`,
    `STREAM_TARGET_DEFS` (horizontal pinned, default server
    `rtmps://rtmp-api.facebook.com:443/rtmp/`) and `oauthUnavailableReason`;
    `bridgeStreamingToLegacy` (map to `'custom'`, like TikTok and Instagram);
    `stream-metadata-summary.ts`; `streaming-tab.tsx` `manualKeyGuidance`
    and `platformLabel`; `comment-highlight.ts`; `caption-overlay.ts`
    glyph; `stream-key-format.ts`; `obs-import-map.ts` (OBS's "Facebook
    Live" service maps to `facebook`); `stream-manager-stats.ts`;
    `activity-pane.tsx` notes; `styles.css` `--color-platform-facebook`;
    `remote_web/app.css`.
- **Contract caps.** `backend-rpc-contract.ts` hard-codes `maxLength: 7` at
  ~l.677, ~l.692 and ~l.1871. An 8th platform would fail audience, viewer and
  co-host events. Derive the cap from `STREAM_PLATFORMS.length` so it can't
  drift again, and update `backend-rpc-contract.test.ts` `everyPlatform`.
- **Guidance copy** (`manualKeyGuidance`), as confirmed by S0.6: "In Facebook
  Live Producer, choose Streaming software and copy the stream key (turn on
  Persistent stream key to reuse it). After Videorc starts streaming, press
  Go live in Live Producer."
  - The Go Live dialog shows the same reminder inline for a stream-key
    Facebook destination. No toast.
- **Icon.** Use Phosphor's `FacebookLogo` in `icons.tsx`. Brand marks don't
  count against the 100 Nucleo glyphs; note it in `docs/icon-set.md`.
- **Budget trap.** `icons.tsx`, `capture.ts`, `use-studio.tsx` and
  `live-chat-view.ts` are in the main window's eager chunk, at 1,999,935 of
  2,000,000 bytes.
  - Free bytes first, the way #489 and #487 did: lazy-load a main-window
    module that isn't needed at first paint. Then add the icon.
  - `pnpm check:renderer-assets` must pass. Gzip on a Mac reads about 1.6 KB
    above CI's Linux gzip, and CI is the gate.
- **Web.** Add `"facebook"` to `lib/ai/cohost.ts` `COHOST_PLATFORMS`, so an
  Orcle tick with a Facebook message is never a 400. **Deploy this first.**
- **Downgrade note.** An older build can't parse a stored `facebook` target
  (strict enum, no `#[serde(other)]`). The updater never downgrades, so
  record this in the PR and move on.
- **Tests and smokes to extend:**
  - `streaming.rs` id round trip and default order;
  - the storage tests;
  - `backend-rpc-contract.test.ts`;
  - `capture.test.ts`, `stream-key-format.test.ts`, `obs-import-map.test.ts`,
    `stream-metadata-summary.test.ts`;
  - `smoke:multistream` `PLATFORMS`, `smoke:platform-lifecycle`,
    `smoke:start-labels`, `smoke:streaming-secrets` (a manual Facebook key
    persists and is redacted), `smoke:live-chat-fake-providers` (capability
    loop), `smoke:oauth-guards`.

Done when:

- `pnpm typecheck`, `lint`, `format:check`, the desktop tests and
  `check:renderer-assets` pass;
- the targeted `cargo test -p videorc-backend streaming storage live_chat oauth audience`
  passes, with clippy and fmt clean;
- the smokes above pass;
- the owner streams Videorc to their Page with a pasted persistent key,
  presses Go live in Live Producer, and sees the live.

### S2: Connect a Facebook Page (dark in public builds)

- **Sign-in, option A** (device login):
  - A Facebook device grant in `oauth.rs` next to Twitch's: the same pending
    session and background poller, and the same `complete_oauth_callback`
    path.
  - Build-time config: `VIDEORC_BUNDLED_FACEBOOK_APP_ID` and
    `VIDEORC_BUNDLED_FACEBOOK_CLIENT_TOKEN` (the client token is meant to be
    embedded).
  - The desktop shows the user code plainly next to "Open Facebook". Facebook
    doesn't pre-fill it the way Twitch does.
- **Sign-in, option B** (web broker; `videorc-web`, deployed before the
  desktop release):
  - `GET /api/oauth/facebook/start?state&redirect_uri&code_challenge`:
    - accepts only a loopback `http://127.0.0.1|localhost:<port>/oauth/callback`;
    - seals `{state, redirect_uri, code_challenge, exp}` with
      `OAUTH_BROKER_SEAL_KEY` (AES-GCM);
    - 302s to `https://www.facebook.com/v26.0/dialog/oauth` with the HTTPS
      callback and the sealed state.
  - `GET /api/oauth/facebook/callback`:
    - unseals;
    - exchanges the code with the secret;
    - swaps the result for the 60-day token (`fb_exchange_token`);
    - seals `{token, expires_in, code_challenge, exp: now + 120 s}` into a
      one-time `code`;
    - 302s to the desktop loopback with the desktop's `state`.
  - `POST /api/desktop/oauth/facebook/redeem` with `{code, code_verifier}`:
    checks the expiry and `S256(verifier) == challenge`, and returns a
    standard token response. The desktop's `exchange_authorization_code`
    works unchanged, with `token_url` set to the redeem route and `pkce: true`.
  - It is stateless, stores nothing, and needs no Videorc account.
  - Update the privacy page in the same PR: "Facebook's sign-in passes
    through our server once and is never stored."
  - `validate_provider_redirect_uri` stays loopback-only.
- **Both options need web callbacks:**
  - `POST /api/oauth/facebook/data-deletion`: verify the `signed_request`
    with the app secret, then return `{url, confirmation_code}` plus a status
    page saying Videorc's servers hold no Facebook data, and how to disconnect
    in the app.
  - `POST /api/oauth/facebook/deauthorize`: verify and log only.
- **Page picker.**
  - After sign-in, the desktop calls
    `GET graph.facebook.com/v26.0/me/accounts?fields=id,name,picture,tasks,access_token`
    and lists the Pages where `tasks` includes `CREATE_CONTENT`.
  - `platform_accounts` has one row per platform (`platform UNIQUE`). The
    row is the **selected Page**, mirroring YouTube's channel select
    (`platformAccounts.youtube.selectChannel`):
    - `account_id` = Page id, label = Page name, avatar = Page picture;
    - token = Page token, `expires_at` = none;
    - the 60-day user token goes in its own secret, only for switching
      Pages. When it expires, switching asks for a reconnect but streaming
      keeps working.
- **No refresh.** `session_platform_access_token` and
  `refresh_platform_access_token` must not try a refresh for Facebook,
  because there is no refresh token. Graph error 190 (OAuthException)
  becomes NeedsReconnect with "Reconnect Facebook". Disconnect deletes both
  secrets. Facebook has no token revocation to call beyond an optional
  `DELETE /me/permissions`.
- **Where it's on.** Connected mode is on only when the app id is bundled
  **and** `VIDEORC_BUNDLED_FACEBOOK_OAUTH_ENABLED` is set (the same pattern as
  YouTube's `VIDEORC_BUNDLED_YOUTUBE_OAUTH_ENABLED`). Until S6, the owner's
  dev builds and a runtime override enable it; public builds show stream key
  only.
- **Release lists.** The new names go in the **optional** list
  (`release-bundled-oauth.mjs` `RELEASE_OPTIONAL_BUNDLED_OAUTH_ENV`),
  `github-release-secrets.mjs`, the macOS artifact validation (no secret in
  `app.asar`) and all three release workflows at once (the #460 lesson).
  Required names would fail the Windows and Linux preflights before the
  secrets exist.
- **Graph version.** Pin it in one constant, `FACEBOOK_GRAPH_VERSION = "v26.0"`.
- **Redaction.** Never log an access token. Graph URLs carry
  `access_token=` in the query, so extend `redact_stream_urls` (or a sibling
  redactor) to strip `access_token` and `appsecret_proof` from every logged
  URL, with a test.

Done when:

- the `oauth` tests cover the device or broker path, Page selection, error
  190 → NeedsReconnect, and a disconnect that deletes the secrets;
- the web tests cover the seal/unseal round trip, PKCE mismatch refusal,
  expiry, a non-loopback redirect refusal and the signed-request check;
- `smoke:oauth-guards` and `smoke:provider-readiness` know Facebook (the
  broker callback, if B, joins `REQUIRED_OAUTH_CALLBACK_URLS`);
- the owner connects their Page in a dev build.

### S3: Go Live on a connected Page

A new `crates/videorc-backend/src/facebook.rs` follows `x_live.rs`'s shape:
prepare, publish after ingest, end at stop.

- **Prepare** (`streamTargets.facebook.prepare`, called from
  `prepareOauthTargetsForGoLive`):
  - `POST /{page}/live_videos` with `status=UNPUBLISHED`, `title`,
    `description`, `enable_backup_ingest=false` and
    `fields=id,secure_stream_url,video{id}`.
  - Split `secure_stream_url` at `/rtmp/` into server and key, and store the
    key under `platform:facebook:{page}:stream-key`.
  - Set `platform_broadcast_id` to the live video id and remember the video id
    for S4.
  - Normalise the server URL the way `kick_ingest_server_url` does, and test
    it with a bare host.
- **Publish** (`.publish`, called from the activation step next to
  `activatePreparedXBroadcasts`):
  - Once our FFmpeg leg is up, poll
    `GET /{id}?fields=status,ingest_streams{stream_health}` every 2 s for up
    to 30 s.
  - When an ingest stream shows up, `POST /{id}` with `status=LIVE_NOW`.
  - If none shows up, the destination fails with "Facebook didn't receive the
    stream". `DELETE /{id}` the unpublished object so nothing lingers.
- **End** (`.end`, from `completePreparedPlatformBroadcasts` and
  `settlePreviousPlatformLifecycle`): `POST /{id}` with
  `end_live_video=true`. A live left running by a crash is ended on the next
  launch.
- **Mid-stream.** Follow S0.4. If Facebook reads a short encoder drop as the
  end, the status poll (S5) sees `VOD` while we are still pushing:
  - fail the destination;
  - add a destination-failed row: "Facebook ended the live after the stream
    dropped";
  - never create a second live on its own, because that would post a second
    video on the Page.
- **Errors, in plain copy:**
  - `1363120`: "Facebook allows live only for accounts older than 60 days."
  - `1363144`: "This Page needs 100 followers before it can go live."
  - Missing `CREATE_CONTENT`: "You need to be able to post on this Page."
  - Rate limit (32 or 80001): "Facebook is rate-limiting this Page; try
    again in a few minutes."
  - `LIVE_VIDEO__PRIVACY_REQUIRED`: Pages are always public, so this
    shouldn't happen; if it does, log it and show a generic error.
- **Metadata.**
  - Add `facebook` to `STREAM_METADATA_PLATFORMS`. The tests that assert four
    rows must follow.
  - Title (254 characters at most, validated in `streaming.rs`) and
    description. Privacy is fixed ("Page lives are public"), with no picker.
  - Any new `Option` wire field gets `skip_serializing_if`, because of the
    serde null trap.
- **Preflight.** `preflight.rs` `destination_preflight`: a connected
  Facebook destination needs a selected Page and a Page token that works
  (`GET /{page}?fields=id` with the Page token).
- **Renderer.** Put the Facebook prepare, publish and end calls in a lazily
  imported `lib/facebook-live.ts`, the precedent being `use-studio.tsx`'s
  `await import('@/lib/scheduled-streams')`. Nothing new goes into the eager
  chunk.
- **RPC policy.** Add each new method to the execution-policy lists
  (`main.rs` mutations and reads). The generated policy test fails
  otherwise.

Done when:

- `facebook.rs` mock-Graph tests pass for create, publish after ingest, no
  ingest (delete), end, crash recovery, each error mapping, and URL
  splitting;
- the integration test in `studio-provider.integration.test.ts` passes;
- `smoke:platform-lifecycle` and `smoke:multistream` pass;
- a dev-build stream from the owner goes live on the Page with our title,
  the Page shows it live only after our push, and Stop ends it as a VOD.

### S4: Comments in the Stream Manager (read and send)

A new `facebook_chat.rs` connects directly from the desktop; there's no
relay.

- Start it after publish, the way `liveChat.x.start` starts after X's
  broadcast exists.
- **Read.** Use SSE `live_comments` with the parameters S0.3 confirmed.
  - Reconnect with backoff.
  - If SSE refuses or goes quiet for 60 s while the live is on, fall back to
    polling `GET /{id}/comments?order=reverse_chronological&live_filter=no_filter&since=…`
    every 4 s.
  - Dedupe by comment id.
- **Normalise** to `LiveChatMessage`:
  - author name from `from.name`; `author_id` is the Page-scoped id;
  - no avatar (initials), until the avatar feature is approved;
  - `raw_provider_type: "facebook.comment"`;
  - the Page's own comments marked as ours, so a sent message and its echo
    are one row.
- **Privacy.** A Page-scoped id never feeds anything across platforms
  (Orcle memory, named followers). Keep Facebook authors separate from other
  platforms' authors.
- **Send.** A `ChatSenderConfig::Facebook` variant:
  - `POST /{video.id}/comments` with the Page token returns a
    `ProviderSendReceipt` with the comment id;
  - set the character cap in `chat-send.ts` from the Graph docs;
  - add Facebook to the `preflight.rs` message matrix.
- **Capability.** In `chat_capability`, connected mode is read and send, and
  stream-key mode stays Unsupported with the S1 copy.
- **Fake provider.** Add Facebook fake events to `live_chat.rs` `fake_events`
  for `smoke:live-chat-fake-providers`.

Done when:

- `cargo test -p videorc-backend facebook_chat live_chat preflight` passes,
  covering SSE parsing, the polling fallback, dedupe, echo and a 190 →
  reconnect state;
- `smoke:live-chat-fake-providers` and `pnpm probe:comments-window` pass;
- in an owner dev stream, a comment from a test account shows within seconds,
  and "Thank in chat" posts as the Page.

### S5: Viewers and followers

- **`viewer_stats.rs`.** Add a `FacebookViewerConfig` slot to
  `run_viewer_sampler` (it takes one positional slot per platform).
  - Poll `GET /{id}?fields=live_views,status` every 15 s.
  - Report `None` unless `status` is `LIVE`, never 0 (plan 066 rule).
  - `status` of `VOD` while streaming feeds S3's mid-stream failure.
- **`audience.rs`.** Read Page `followers_count` every 120 s as a followers
  metric, with gains.
  - Activity's unnamed-gain line says "Facebook doesn't say who followed".
  - The capability note joins `activityCapabilityNote`.
- **Rate budget.** Read `X-Business-Use-Case-Usage` on every Graph response.
  Above 75 % of any bucket, double the poll intervals; above 90 %, pause
  viewer polls and say so in the stat's hover.
- **Renderer.** `stream-manager-stats.ts` `VIEWER_PLATFORMS`, the status bar
  hover, and a provider-facts doc update.

Done when the `viewer_stats` and `audience` tests pass,
`stream-manager-stats.test.ts` and `stream-activity.test.ts` pass,
`probe:comments-window` passes, and an owner stream shows Facebook viewers
and followers in the stats bar.

### S6: App Review, the public switch, and acceptance

- **The review package** (owner-led, agent-prepared):
  - A test build with reviewer credentials, and instructions to add the
    reviewer to the app.
  - One screencast per permission, at 1080p or better, English, no audio:
    connect → Page picker → Go Live → the live on the Page → a comment read →
    Thank in chat posting as the Page → Stop.
  - The privacy policy and data-deletion URLs, and the data-use answers.
- After approval: Advanced Access, then Access Verification (about 5 days).
- **The switch.** Set `VIDEORC_BUNDLED_FACEBOOK_OAUTH_ENABLED` in the release
  environment for the next release on all three platforms. Update the web
  marketing lists (`destination-marks.ts`, `multistream-guide`, metadata,
  FAQ) in a web PR that goes live the same day.
- **Acceptance** on a packaged build, recorded in
  `docs/acceptance/<date>-facebook-live.md`:
  - stream-key mode to one Page;
  - connected mode with Facebook, YouTube and Twitch at once;
  - title shown, public only after the push, comments both ways, viewers and
    followers shown, Stop leaves a VOD;
  - a dual-orientation session sends Facebook the horizontal leg;
  - an eligibility refusal reads clearly (use a new test Page).

## Verification summary

- **Rust:** targeted
  `cargo test -p videorc-backend {streaming,storage,oauth,facebook,facebook_chat,live_chat,audience,viewer_stats,preflight}`,
  plus `cargo clippy -p videorc-backend -- -D warnings` and
  `cargo fmt --check --all`. Don't run the full suite (owner directive).
  After any `cfg` edit, also run `cargo build --release`.
- **Renderer:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
  `pnpm --filter @videorc/desktop test`, `pnpm check:renderer-assets` and
  `pnpm probe:comments-window`.
- **Smokes:** `smoke:multistream`, `smoke:platform-lifecycle`,
  `smoke:start-labels`, `smoke:streaming-secrets`, `smoke:oauth-guards`,
  `smoke:provider-readiness` and `smoke:live-chat-fake-providers`.
- **Web:** the videorc-web tests and lint for the broker and callbacks.
  Deploy before any desktop release that depends on them.
- **Recording:** the recording and encoder code isn't touched (the Facebook
  leg uses the existing stream encode), so recording-studio smokes are not
  required. If a slice ends up changing `recording.rs` stream-leg code, run
  `pnpm smoke:recording-studio`.

## Risks

- **Meta review timing.** It sets the public date (4–8 weeks). S1 gives
  users Facebook right away through a stream key.
- **Device login may not grant Page permissions.** Then option B, and the
  privacy text changes.
- **Encoder drops.** Facebook may end a live on a short drop (S0.4). We
  report it and never re-create a live on our own.
- **Eligibility** (60 days, 100 followers) blocks small creators. Clear copy
  is all we can do.
- **SSE deprecation risk:** its reference page is gone. Polling is the
  fallback.
- **Small-Page rate budgets:** use SSE plus gentle polls and back off on the
  usage header.
- **Eager budget:** the icon and labels land in the eager chunk. Free bytes
  first (S1).
- **Contract caps and the silent `Custom` fallback:** covered by S1's tests.
- **Token loss** (password change, role removed): error 190 → reconnect, and
  the deauthorize callback is logged.
- **Retention:** Facebook deletes lives after 30 days. The recording is the
  archive; mention it in the Go Live help text.

## Sources (Meta, checked 2026-09-30)

- Live Video API: https://developers.facebook.com/documentation/live-video-api
  (overview, getting-started, guides/streaming, guides/scheduling,
  interact-with-viewers)
- LiveVideo reference: https://developers.facebook.com/docs/graph-api/reference/live-video/
  and `/comments/`
- Permissions: https://developers.facebook.com/documentation/development/permissions
- Access levels: https://developers.facebook.com/docs/graph-api/overview/access-levels/
- Access Verification: https://developers.facebook.com/documentation/development/release/access-verification
- Long-lived tokens: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
- Manual login flow: https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
- Login for Devices: https://developers.facebook.com/documentation/facebook-login/for-devices
- Login security (Strict Mode, HTTPS): https://developers.facebook.com/documentation/facebook-login/security
- Encoder spec: https://www.facebook.com/business/help/162540111070395
- Live Producer and streaming software: https://www.facebook.com/business/help/165076674943644
  and https://www.facebook.com/business/help/767179794442688
- Groups API removal (v19): https://developers.facebook.com/docs/graph-api/changelog/version19.0
- Rate limiting: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- Data-deletion callback: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
- App Review submission: https://developers.facebook.com/docs/app-review/submission-guide
- Live storage policy (30 days): https://about.fb.com/news/2025/02/updating-our-facebook-live-video-storage-policy/
- SSE `live_comments` (archived 2023): https://web.archive.org/web/20230905065405/https://developers.facebook.com/docs/graph-api/server-sent-events/endpoints/live-comments/
- LinkedIn (the dropped research): https://learn.microsoft.com/en-us/linkedin/consumer/integrations/live-video/
  and https://www.linkedin.com/legal/l/live-events-api-terms
