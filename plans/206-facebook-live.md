# Plan 206: Facebook Live in the Livestream tab

> **Executor instructions**: read `AGENTS.md`, the `videorc-design` skill and
> this whole plan first. Work in your own worktree from `origin/main`, never
> from `feat/windows-owner-waiver` (the main checkout's branch, hundreds of
> commits behind). Phase 1 is one desktop PR. Write and commit every slice
> first, then run the gates once at the end (owner feedback "Gates at the
> end"). Check every UI in light AND dark, in the default look AND Retro LCD.
> Stop and report on any STOP condition instead of improvising. When a PR
> lands, update the Status table and the row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git log --oneline dc1309cb..origin/main -- apps/desktop/src/shared/backend.ts apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/renderer/src/lib/capture.ts apps/desktop/src/renderer/src/components/streaming/destination-card.tsx apps/desktop/src/renderer/src/components/go-live-dialog.tsx apps/desktop/src/renderer/src/lib/obs-import-map.ts crates/videorc-backend/src/streaming.rs crates/videorc-backend/src/live_chat.rs crates/videorc-backend/src/storage.rs scripts/check-renderer-asset-budget.mjs`.
> Line numbers were read at `origin/main` `dc1309cb`. If an anchor moved,
> find it again by symbol. If the _behaviour_ changed, stop and report.

**Owner request (2026-10-27):** "we need connector in livestream tab like for
other platforms, and we can start with livestream key only, and do the rest
until we're approved by Meta."

**Replaces:** plan 079 (2026-09-30). Its stream-key slice was built as
desktop #504, which the owner closed as stale on 2026-10-23 (532 commits
behind). Plan 079, its Graph API research and the #504 code stay on
`origin/feat/079-facebook-live` for reference. Read them; don't rebase them.

**Owner route:** Orchestrator, then Implementation per slice (fit 9).
**Model lanes:**

- `gpt-6.1-sol`: S1, S4, S5 (enum plumbing, OBS import, tests and smokes).
- `opus-5.5`: S2, S3 (the card, its copy, the Go Live reminder). Read the
  `videorc-design` skill first.
- `fable-5.1`: S6 to S10 (Meta spike, sign-in, the broadcast lifecycle,
  comments, viewers).

## Status

| Slice | What                                                   | Phase | State                       |
| ----- | ------------------------------------------------------ | ----- | --------------------------- |
| S0    | Drift check, bundle baseline, Live Producer facts      | 1     | BUILT                       |
| S1    | Facebook as a platform (enums, wire, contract caps)    | 1     | BUILT                       |
| S2    | The Facebook card in Livestream                        | 1     | BUILT                       |
| S3    | Go Live reminder, chat and Stream Manager say "no API" | 1     | BUILT                       |
| S4    | OBS import fills the Facebook card                     | 1     | BUILT                       |
| S5    | Release note, docs, smokes, gates, owner live take     | 1     | BUILT, owner live take owed |
| M1    | Owner: Business Verification and the Meta app          | 2     | PLANNED                     |
| S6    | Meta spike: sign-in, go-live, drops, comments          | 2     | PLANNED                     |
| S7    | Connect a Facebook Page (dark in public builds)        | 3     | PLANNED                     |
| S8    | Go Live on a connected Page                            | 3     | PLANNED                     |
| S9    | Comments in the Stream Manager, Studio chat and Buddy  | 3     | PLANNED                     |
| S10   | Viewers and followers                                  | 3     | PLANNED                     |
| S11   | App Review, the public switch, acceptance              | 4     | PLANNED                     |

## Phase 1 as built (2026-10-27)

One desktop PR from `dc1309cb` (no drift). Where it differs from the slices
below:

- **Server URL:** `rtmps://live-api-s.facebook.com:443/rtmp/`, the one Live
  Producer shows (OBS lists `rtmp-api.facebook.com`; both import into the
  card). The 100-follower and 60-day rule applies to stream-key lives too, so
  the card says "Pages and professional profiles need 100 followers."
- **One platform list:** `shared/stream-platforms.ts` holds `STREAM_PLATFORMS`;
  the `StreamPlatform` union, the wire enum, all seven caps and the three
  hand-written lists derive from it.
- **Chat rows:** Facebook stays out of the always-on capability list, like
  TikTok and Instagram. A session that streams to Facebook gets its
  "Facebook comments need Facebook sign-in, which isn't available yet." row
  from its destination. So `smoke-live-chat-fake-providers` is unchanged; a
  `live_chat` unit test covers the row.
- **Storage test:** stream targets are saved by the renderer, not
  `storage.rs`, so the round-trip test is a serde test in `streaming.rs` plus
  the `smoke:streaming-secrets` reload.
- **Go Live reminder:** one "Publish in Live Producer" alert for Facebook and
  Instagram, in any orientation. Instagram's line used to live in the
  both-orientations advice, so a vertical-only Instagram session never saw it.
- **Key format:** no Facebook shape (none is documented).
- **Release note:** in the PR body (the changelog file is written at release
  time).
- **Bundle:** eager gzip 400,604 at `dc1309cb`, 400,856 with Phase 1
  (+252 bytes; raw +779). Limit 405,000 unchanged.

## The shape

- **Phase 1, stream key (ships in the next release, no Meta needed).** A
  Facebook card joins the horizontal group in Livestream, after X. It works
  like the Instagram card: the server is filled in, the user pastes the
  stream key from Facebook Live Producer, and presses Go live there once
  Videorc is sending. No sign-in, no comments, no viewers, no title.
  Works for Pages and profiles in professional mode. Groups also work this
  way (Meta removed the Groups API in 2024, so a key is the only way in).
- **Phase 2, Meta setup (owner, starts the same day as Phase 1).** Business
  Verification, the Meta app, test roles. One spike settles the facts that
  decide how sign-in works.
- **Phase 3, connected Page (built while Meta reviews).** Sign in with
  Facebook, pick a Page, Go Live creates the live with our title, comments
  and viewers in the Stream Manager, Stop ends it. Before approval it only
  works for people with a role on the Meta app (owner and testers); public
  builds still show the stream-key card only.
- **Phase 4, the switch.** App Review, Access Verification, then one release
  env var turns connected mode on for everyone, and the website lists
  Facebook.

Realistic time to public connected mode: 4 to 8 weeks, set by Meta. Phase 1
is days.

## Decisions

Owner calls are marked **OWNER**; the rest are settled.

- **D1. Card place.** Horizontal group, after X: YouTube, Twitch, Kick, X,
  Facebook, then the vertical trio, then Custom RTMP. Horizontal only;
  a dual-orientation session sends Facebook the horizontal leg.
- **D2. Frame rate.** Facebook takes 1080p60 (H.264 Level 4.2, 4.5 to
  9 Mbps), so the Facebook card allows 60 fps like Twitch and Kick. The
  app-wide 1080p / 6000 kbps cap for non-YouTube platforms stays.
- **D3. No Premium gate.** Multistreaming is free with 5 enabled
  destinations on every tier (`entitlements.rs:33`). Facebook counts as one.
- **D4. No web change in Phase 1.** Co-host and Buddy never see a Facebook
  message in stream-key mode (there are no comments), and the web telemetry
  list already accepts `facebook` (`videorcweb lib/stream-telemetry.ts`).
  Web PR #60 (co-host accepts `facebook`) is not needed until S9; close it
  and redo it there.
- **D5. Pages first in connected mode.** Profiles (`publish_video`) are a
  follow-up: a profile live defaults to friends-only visibility, tools get
  no comments unless the user makes it public, and it doubles the review
  surface. Stream-key mode already covers profiles.
- **D6 (OWNER). The website.** Recommendation: list Facebook as a
  destination on videorc.com when the Phase 1 release ships, since it works
  for everyone with a key. The alternative is to wait for Phase 4.
- **D7 (OWNER, after S6). How sign-in works.** Meta's code exchange needs
  the app secret, and the privacy page promises that platform tokens never
  touch our servers (`videorcweb app/privacy/page.tsx` ~l.284).
  - **A. Device code** (recommended if S6 proves it grants Page
    permissions): the user types a code at facebook.com/device, like Twitch.
    The privacy promise stands.
  - **B. Website relay:** a normal browser sign-in through videorc.com that
    stores nothing. The privacy page changes to "passes through once, never
    stored".
  - Bundling the secret in the app is rejected (Meta forbids it).

## Facebook facts (checked 2026-10-27)

- **Who can go live:** since 2024-06-10 the Facebook account must be 60+
  days old and the Page or professional-mode profile needs 100+ followers.
  The API refuses with subcodes `1363120` (age) and `1363144` (followers).
  A brand-new test Page can't go live, so the owner's Page is the test Page.
- **Ingest:** RTMPS only. H.264 CBR with a key frame every 2 s, AAC 48 kHz,
  at most 1080p. Our stream encode already matches (2 s GOP at
  `recording.rs:15803`, AAC 48 kHz 160k at `recording.rs:21469`). RTMPS is
  already accepted (`recording.rs:24629`).
- **Go-live via API:** `POST /{page_id}/live_videos` returns `id` and
  `secure_stream_url` (the key is everything after `/rtmp/`). `LIVE_NOW`
  publishes the moment the stream arrives. Meta's 2026 guide shows a
  `PREVIEW` status plus an in-band `onGoLive` AMF0 message for a
  frame-accurate start; plan 079 used `UNPUBLISHED` then `LIVE_NOW`. S6
  picks one. End with `POST /{id}?end_live_video=true` (leaves a VOD).
  Health refreshes every 2 s; 4 s of no data counts as a timeout.
- **Permissions (Pages):** `pages_show_list`, `pages_manage_posts`,
  `pages_read_engagement` (create the live), `pages_read_user_content`
  (read comments), `pages_manage_engagement` (comment as the Page), plus the
  Live Video API feature. All need App Review, Advanced Access (Business
  Verification) and Access Verification. App-role users can use them before
  review.
- **Tokens:** a Page token derived from a long-lived user token doesn't
  expire. There are no refresh tokens: a dead token (password change, role
  lost, app removed) means sign in again.
- **Comments:** poll `GET /{live_video_id}/comments` or the SSE stream
  `streaming-graph.facebook.com/{id}/live_comments` (its reference page is
  gone; S6 checks it still works). Commenter avatars need a second review.
- **Viewers:** `live_views` on the live video; Page `followers_count`. No
  follow events.
- **Groups:** API removed 2024-04-22. Stream key only, no comments for any
  app.
- **Retention:** since 2025-02 Facebook deletes lives after 30 days unless
  saved. The local recording is the archive.
- Full research with every endpoint: plan 079 on
  `origin/feat/079-facebook-live` (`plans/079-facebook-live.md`).

## Phase 1: stream key

One desktop PR. No Meta app, no web PR.

### S0: Drift check, bundle baseline, Live Producer facts

- Run the drift check above.
- Record the eager bundle baseline: `pnpm check:renderer-assets` (limit
  405,000 gzip, measured 400,072 at `dc1309cb`,
  `scripts/check-renderer-asset-budget.mjs:50-60`). Phase 1 adds an icon and
  a few strings to the eager chunk; it must stay under the limit without
  raising it.
- From Meta's help pages, confirm and write into the PR description:
  - the Server URL Live Producer shows for "Streaming software" (expected
    `rtmps://live-api-s.facebook.com:443/rtmp/`; OBS ships
    `rtmps://rtmp-api.facebook.com:443/rtmp/`; both are Meta hosts);
  - the "persistent stream key" option and its wording;
  - whether the user must press Go live in Live Producer after the encoder
    connects (expected: yes);
  - whether the 100-follower and 60-day rule applies to stream-key lives
    (expected: yes; if so, S2's copy says it).
- **STOP** if Meta's pages say stream-key lives need something the card
  can't explain in one sentence.

Done when the PR description has the four facts with links, and the bundle
baseline.

### S1: Facebook as a platform

Add `facebook` everywhere a platform is listed. No UI yet beyond what the
compiler forces.

- **TS identity:** `StreamPlatform` (`shared/backend.ts:1005`) and
  `STREAM_PLATFORMS` (`shared/backend-rpc-contract.ts:1085-1094`). Leave
  `RtmpPreset` (`backend.ts:971`) alone: the legacy bridge maps Facebook to
  `custom`, as it does TikTok and Instagram (`capture.ts:2267-2270`).
- **Hand-written lists** (no compiler help): `shared/chat-delivery.ts:103`,
  `shared/session-chat-totals.ts:30`, `main/smoke-command-security.ts:460`.
- **Contract caps.** `maxLength: 7` is hard-coded in 7 places:
  `backend-rpc-contract.ts:1282`, `:1297`, `:3410`, `:3884`, `:4008`,
  `:4056` and `session-chat-totals.ts:31`. An 8th platform would make every
  audience, viewer and co-host event fail validation. Derive each from
  `STREAM_PLATFORMS.length` (export one constant) so it can't drift again,
  and change `backend-rpc-contract.test.ts:2257-2264` to assert that
  `length + 1` entries fail and `length` entries pass.
- **Rust identity:** `StreamPlatform` (`streaming.rs:16-26`, kebab-case
  serde), `stream_platform_from_id` (`streaming.rs:471-482`) and its
  round-trip test (`:743-762`). `default_stream_targets`
  (`streaming.rs:652-693`) gets the Facebook target, horizontal, after X.
- **Compiler-forced Rust sites:** `streaming.rs:460`, `:573`;
  `live_chat.rs:693-719` (Unsupported, copy in S3), `:1988`;
  `main.rs:3571` (no chat setup); `oauth.rs:617`, `:2623`, `:2936-3004`
  (Facebook has no provider config yet: refuse with "Signing in with
  Facebook isn't available yet."); `oauth_callback_page.rs:34-38`;
  `cohost_greetings.rs:257` (no greeting); `seventv.rs:62-67` (no emotes);
  the `preflight.rs:919` test helper.
- **Silent Rust sites to check by hand:** `audience.rs:564`, `:1027`;
  `oauth.rs:151`; `cohost.rs:7628`; `live_chat_moderation.rs:998`;
  `main.rs:3588`; `preflight.rs:267`. None needs a Facebook branch in
  Phase 1; each needs a glance so a default doesn't do something wrong.
- **Storage callers that turn an unknown id into Custom**
  (`storage.rs:7640`, `:9109`, `:9198`) are fine once the enum knows
  `facebook`. Add one storage test that a saved Facebook target round-trips.
- **Compiler-forced TS sites** (every `Record<StreamPlatform, …>`):
  `lib/platform-copy.ts:10` (label "Facebook"), `lib/capture.ts:953`
  (output caps: 1080p, 6000 kbps, 60 fps per D2), `lib/live-chat-view.ts:521`,
  `lib/chat-send.ts:19`, `components/chat-platform-icon.tsx:29`, `:38`,
  `components/platform-glyph.tsx:18`, `:30` (glyph lands in S2; a
  placeholder that type-checks is fine here), `shared/platform-scopes.ts:146-158`.
- **Downgrade, accepted:** an older build drops the Facebook card
  (`normalizeStreamingSettings`, `capture.ts:2120-2137`, drops unknown ids)
  and its strict Rust enum can't parse a stored `facebook` target. The
  updater never downgrades. Note it in the PR.

Done when `pnpm typecheck` passes and
`cargo test -p videorc-backend streaming storage` plus
`pnpm --filter @videorc/desktop test -- backend-rpc-contract platform-copy platform-scopes`
pass.

### S2: The Facebook card in Livestream

- **Table entry** in `STREAM_TARGET_DEFS` (`capture.ts:695-728`), after X:
  `{ id: 'facebook', platform: 'facebook', label: 'Facebook', serverUrl: <S0 URL> }`
  (no `outputOrientation`, so horizontal). Add `facebook` to
  `STREAM_PLATFORM_ORDER` (`capture.ts:679`) after `x`, and fix the comment
  above it.
- **Sign-in unavailable.** `oauthUnavailableReason` (`capture.ts:730-738`)
  returns `null` for an unlisted platform, which means "sign-in available",
  so the card would offer Sign in. Add Facebook:
  "Signing in with Facebook isn't available yet. Use a stream key from Live
  Producer."
- **Metadata label trap.** `metadataPlatformLabel`
  (`stream-metadata-summary.ts:17-33`) defaults to `'Custom'`, which would
  read "Custom uses a stream key." Add Facebook.
- **Guidance** in `manualKeyGuidance` (`destination-card.tsx:726-764`),
  modelled on Instagram's:
  "Facebook keys come from Live Producer: choose Streaming software and turn
  on Persistent stream key to reuse it. Start the stream here, then press
  "Go live" there." Link `https://www.facebook.com/live/producer`, label
  "Live Producer". If S0 confirms the follower rule applies, add: "Your Page
  or professional profile needs 100 followers."
- **Readiness:** `lib/destination-readiness.ts:15-30` treats Facebook like
  Instagram (server prefilled, key required).
- **Key format:** `lib/stream-key-format.ts:9-29` warns on mismatched shapes
  for Twitch, YouTube and Kick only. Add a Facebook shape only if S0 finds a
  documented one (`FB-…` keys); otherwise leave it out. It never blocks a
  save either way.
- **Icon.** Phosphor's `FacebookLogo` in the brand-mark registry
  (`components/icons.tsx:286-290`) and the glyph-name union (~`:85-140`).
  Brand marks don't count against the 100 Nucleo glyphs; note it in
  `docs/icon-set.md` (`:24`, `:167`). Wire it in `platform-glyph.tsx` and
  `chat-platform-icon.tsx`.
- **Colour:** `--color-platform-facebook` next to the others
  (`styles.css:514-519`), Facebook blue `#0866FF`, checked in light and dark.
  Remote control: a rule in `remote_web/app.css:350-385`.
- **Retro LCD:** check the card and glyph in the Retro LCD look.

Done when the card shows in both themes and both looks, a key saves and
reloads as a masked hint, the Sign in toggle never appears, and the
destination-card tests cover Facebook.

### S3: Go Live reminder; chat and Stream Manager say "no API"

- **Go Live reminder.** The Instagram "press Go live in Live Producer" line
  lives inside `GoLiveSimulcastAdvisory` (`go-live-dialog.tsx:866-900`),
  which only renders for dual-orientation sessions (`:380`). Facebook is
  horizontal, so it would never show. Add a small reminder that renders
  whenever an enabled Facebook card is in `sentStreaming`, in any
  orientation: "Facebook: once Videorc starts sending, press "Go live" in
  Facebook Live Producer to publish the stream." Inline in the dialog, no
  toast.
- **Chat capability.** `chat_capability` (`live_chat.rs:693-707`):
  Facebook is Unsupported with "Facebook comments need Facebook sign-in,
  which isn't available yet."
- **Preflight.** The key-only chat-limits warning (`preflight.rs:265-275`)
  should cover Facebook automatically; add a test that it does.
- **Activity note.** `activity-pane.tsx:149-150` reads "TikTok, Instagram and
  custom RTMP have no public live API." Facebook has one, just not in
  stream-key mode. New copy: "Facebook with a stream key, TikTok, Instagram
  and custom RTMP don't share comments or viewers."
- **Lists that stay without Facebook in Phase 1:** `VIEWER_PLATFORMS` and
  `TIP_PLATFORMS` (`stream-manager-stats.ts:87-88`), `LIVE_CHAT_PLATFORMS`
  (`live-chat-view.ts:22`), `SIGN_IN_PLATFORMS` (`go-live-dialog.tsx:62`),
  the metadata rows (`stream-metadata-summary.ts:11-15`,
  `streaming.rs:514-519`). Leave a one-line comment at each pointing at S8
  to S10 so the connected slices find them.
- **Discord go-live post:** `discord_announce/mod.rs:916` has no Facebook
  watch link (falls through to `None`). Fine for Phase 1.

Done when `go-live-panel.test.ts` covers the reminder in a horizontal-only
session, and `cargo test -p videorc-backend live_chat preflight` passes.

### S4: OBS import fills the Facebook card

- `detectPlatform` (`obs-import-map.ts:169-185`) knows only YouTube, Kick
  and Twitch, so OBS's "Facebook Live" service becomes
  `oauth-suggest`/`other` (`:500-509`) and tells the user to "Connect the
  account in Livestream", which is wrong for a key-only card.
- Map OBS "Facebook Live" (and a custom server on a `facebook.com` host) to
  an `rtmp-platform` result for `facebook`, so `obs-import-apply.ts:53`
  copies the key into the Facebook card.

Done when `obs-import-map.test.ts` and `obs-import-apply.test.ts` cover a
Facebook Live profile and a custom server on a Facebook host.

### S5: Release note, docs, smokes, gates, owner live take

- **Release note** in `changelog/<next>.md` (format in `changelog/README.md`):
  "Facebook is a destination in Livestream. Paste the stream key from
  Facebook Live Producer, start the stream, then press Go live there.
  Signing in with Facebook comes later."
- **Docs:** a Facebook section in `docs/specs/stream-manager-provider-facts.md`
  (stream-key only for now, the facts above), and `docs/icon-set.md`.
- **Smokes to extend:**
  - `smoke-multistream-app.mjs:46-52` (add Facebook to the fan-out);
  - `smoke-start-labels.mjs:170-200` (the legacy bridge maps it to custom);
  - `smoke-streaming-secrets.mjs:134-153` (a Facebook key persists and is
    redacted);
  - `smoke-platform-lifecycle.mjs:50`;
  - `smoke-live-chat-fake-providers.mjs:60` (capability loop: Unsupported);
  - `smoke-oauth-guards-app.mjs:104` (still 4 metadata rows; Facebook
    sign-in refused).
- **Gates, once, at the end:**
  - `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
    `pnpm --filter @videorc/desktop test`, `pnpm test:scripts`,
    `pnpm check:renderer-assets`;
  - `cargo test -p videorc-backend streaming storage live_chat oauth preflight cohost_greetings`,
    `cargo clippy -p videorc-backend -- -D warnings`, `cargo fmt --check --all`
    (targeted tests only, owner directive);
  - `pnpm smoke:start-labels`, `smoke:streaming-secrets`,
    `smoke:platform-lifecycle`, `smoke:live-chat-fake-providers`,
    `smoke:oauth-guards`, `smoke:multistream`.
  - Recording and encoder code is untouched (Facebook rides the existing
    stream encode), so the recording-studio smokes aren't needed. If a
    change ends up in `recording.rs`, run `pnpm smoke:recording-studio`.
- **Owner live take (acceptance):**
  1. Stream to the owner's Page with a persistent key, press Go live in Live
     Producer, see the live, stop.
  2. Facebook plus YouTube and Twitch at once.
  3. A dual-orientation session: Facebook gets the horizontal leg.
     Record it in `docs/acceptance/<date>-facebook-live.md`.

Done when the gates pass, the PR is ready, and the owner's take is recorded
(it can follow the merge).

## Phase 2: Meta setup

### M1: Owner checklist (start the same day as Phase 1)

1. **Business Verification** for the Videorc business portfolio. Up to 14
   business days; it gates everything else.
2. **Create the Meta app** (Business type) in that portfolio. Add Facebook
   Login (or Login for Business, whichever S6 settles) and the **Live Video
   API** product. Turn on "Login for Devices" for option A.
3. **App settings:** privacy policy URL; data-deletion callback
   `https://www.videorc.com/api/oauth/facebook/data-deletion`; a 1024 px
   icon; for option B the redirect
   `https://www.videorc.com/api/oauth/facebook/callback` with Strict Mode.
4. **App roles** for the owner and testers, so connected mode works in
   development before review.
5. **IDs:** the app id (and the client token for A) go into
   `~/.videorc-release.env` and the GitHub release secrets; the app secret
   goes to Vercel only. Agents never read `.env` files.
6. **Eligibility:** confirm the owner's Page has 100+ followers and is 60+
   days old.

### S6: Meta spike (no product code)

Throwaway scripts from a scratch directory, never committed, run in the
owner's shell whenever a token is involved, against the owner's Page in
development mode. Record the answers in the Facebook section of
`docs/specs/stream-manager-provider-facts.md`.

1. **Device login and Pages.** Does `/device/login` with
   `pages_show_list,pages_manage_posts,pages_read_engagement,pages_read_user_content,pages_manage_engagement`
   succeed, and does `/me/accounts` then return Page tokens that
   `debug_token` reports as non-expiring? This decides D7.
2. **Go-live flow.** `PREVIEW` plus in-band `onGoLive`, or `UNPUBLISHED`
   then `LIVE_NOW`: which publishes only after our push, with our FFmpeg?
   (In-band needs an AMF0 message our FFmpeg leg may not send; prefer the
   status flip unless it fails.)
3. **Drop tolerance.** Cut our push for 5, 15, 30 and 60 s during a test
   live. Does Facebook resume or end it (status `VOD`)? This sets S8's
   reconnect behaviour.
4. **Comments.** Does SSE `live_comments` still stream? Which fields and
   `comment_rate` values? Otherwise polling.
5. **Our output.** Stream our 1080p30 and 1080p60 profiles at 6 Mbps and
   record `ingest_streams{stream_health}` and any
   `recommended_encoder_settings` warnings.

Done when the facts section is written and the owner has picked D7.

## Phase 3: connected Page (dark in public builds)

Each slice is its own PR. Connected mode is on only when the app id is
bundled **and** `VIDEORC_BUNDLED_FACEBOOK_OAUTH_ENABLED` is set. That is the
gate YouTube used while Google reviewed its scope (`youtube_oauth_enabled()`
in `oauth.rs`, removed by `7abac23a` once approved; read that diff for the
shape and for what S11 removes). Until S11, the owner's dev builds and
app-role testers have it; public builds show the stream-key card.
Plan 079's S2 to S5 hold the detailed design; re-read them against today's
code before each slice.

### S7: Connect a Facebook Page

- **Sign-in per D7:** A is a device grant in `oauth.rs` beside Twitch's
  (`start_twitch_device_grant`), with
  `VIDEORC_BUNDLED_FACEBOOK_APP_ID` and `VIDEORC_BUNDLED_FACEBOOK_CLIENT_TOKEN`
  at build time. B is a stateless web broker in videorc-web (start,
  callback, PKCE-checked redeem; plan 079 S2 has the routes), deployed
  before the desktop release, with the privacy page change in the same web
  PR.
- **Both need web callbacks** for review: data deletion (verify
  `signed_request`, return `{url, confirmation_code}`) and deauthorize
  (verify, log only).
- **Page picker:** `GET /me/accounts?fields=id,name,picture,tasks,access_token`,
  Pages whose `tasks` include `CREATE_CONTENT`. The `platform_accounts` row
  is the selected Page (YouTube's channel-select pattern); the long-lived
  user token is kept only for switching Pages.
- **No refresh:** Graph error 190 means "Reconnect Facebook". Disconnect
  deletes both secrets.
- **The card:** the "Connect with" toggle (`destination-card.tsx:439-450`)
  appears for Facebook only when connected mode is on.
  `oauthUnavailableReason` keeps the S2 copy otherwise.
- **Release lists:** `RELEASE_BUNDLED_OAUTH_ENV`
  (`scripts/lib/release-bundled-oauth.mjs:12-25`) is all-required: every
  name there fails the release preflights when its secret is missing. Keep
  the Facebook names **out** of it until S11. Pass them through the three
  release workflows and `scripts/lib/github-release-secrets.mjs` as
  optional, and keep the macOS artifact validation's no-secret-in-`app.asar`
  check. (Workflow edits need the owner to click merge.)
- **Redaction:** Graph URLs carry `access_token=`; strip it and
  `appsecret_proof` from every logged URL, with a test.
- Pin `FACEBOOK_GRAPH_VERSION` in one constant.

Done when the oauth tests cover sign-in, Page selection, 190 → reconnect and
disconnect; `smoke:oauth-guards` and `smoke:provider-readiness` know
Facebook; the owner connects their Page in a dev build.

### S8: Go Live on a connected Page

- New `crates/videorc-backend/src/facebook.rs` in `x_live.rs`'s shape:
  prepare (create the live per S6.2, store the key from
  `secure_stream_url`), publish after ingest (poll health every 2 s up to
  30 s; none means "Facebook didn't receive the stream" and the unpublished
  live is deleted), end at Stop (`end_live_video=true`), and end a live a
  crash left running on next launch.
- **Drops:** follow S6.3. If Facebook ends the live after a drop, fail the
  destination with "Facebook ended the live after the stream dropped". Never
  create a second live on our own (it would post a second video).
- **Errors in plain words:** `1363120` "Facebook allows live only for
  accounts older than 60 days."; `1363144` "This Page needs 100 followers
  before it can go live."; missing `CREATE_CONTENT` "You need to be able to
  post on this Page."; rate limit (32, 80001) "Facebook is rate-limiting
  this Page. Try again in a few minutes."
- **Title and description:** add `facebook` to the metadata rows
  (`stream-metadata-summary.ts:11-15`, `streaming.rs:514-519`); title up to
  254 characters. Page lives are public; no privacy picker. Any new
  `Option` wire field gets `skip_serializing_if` (serde-null trap). The
  metadata-draft downgrade trap (`storage.rs:6716-6717`: an older backend
  resets the whole draft on an unknown row) applies from here; note it.
- **Go Live dialog:** Facebook joins `SIGN_IN_PLATFORMS`
  (`go-live-dialog.tsx:62`) when connected; the Live Producer reminder
  shows only in stream-key mode.
- **Preflight:** a connected Facebook destination needs a selected Page and
  a working Page token.
- **Renderer:** the prepare/publish/end calls live in a lazily imported
  `lib/facebook-live.ts`; nothing new in the eager chunk. New RPC methods go
  in the execution-policy lists in `main.rs`.
- **Discord:** a connected Facebook live gets its watch link in the Discord
  go-live post (`discord_announce/mod.rs:916`).

Done when mock-Graph tests cover create, publish after ingest, no ingest,
end, crash recovery, each error and the URL split; `smoke:platform-lifecycle`
and `smoke:multistream` pass; a dev-build stream goes live on the owner's
Page with our title, only after our push, and Stop leaves a VOD.

### S9: Comments in the Stream Manager, Studio chat and Buddy

- **Web first:** add `"facebook"` to `COHOST_PLATFORMS`
  (`videorcweb lib/ai/cohost.ts:94`) and regenerate the co-host golden
  digests (what web #60 did). Deploy before the desktop release; otherwise
  Buddy's tick with a Facebook message is a 400.
- New `facebook_chat.rs`: SSE or polling per S6.4, dedupe by comment id,
  the Page's own comments marked as ours, no avatars (initials) until the
  avatar feature passes review. Page-scoped ids never feed cross-platform
  memory.
- **Send:** `POST /{video_id}/comments` as the Page; add Facebook to the
  `chat-send.ts` caps and the preflight message matrix.
- Facebook joins `LIVE_CHAT_PLATFORMS`, so the Stream Manager, Studio chat
  (plan 204), comment highlight (`comment-highlight.ts:185`) and Buddy see
  it. Fake events in `live_chat.rs` for `smoke:live-chat-fake-providers`.

Done when the `facebook_chat` tests pass (parsing, fallback, dedupe, echo,
190), `smoke:live-chat-fake-providers`, `probe:comments-window` and
`smoke:studio-chat` pass, and a test account's comment shows on an owner
dev stream within seconds and "Thank in chat" posts as the Page.

### S10: Viewers and followers

- `viewer_stats.rs` (`:635-709`): a Facebook slot polling `live_views` and
  `status` every 15 s; `None` unless `LIVE`, never 0. A `VOD` status while
  we push feeds S8's drop handling.
- `audience.rs`: Page `followers_count` every 120 s as a followers metric;
  "Facebook doesn't say who followed."
- Back off on the `X-Business-Use-Case-Usage` header (double intervals above
  75 %, pause viewer polls above 90 %).
- Facebook joins `VIEWER_PLATFORMS` (`stream-manager-stats.ts:87`).

Done when the `viewer_stats` and `audience` tests pass and an owner dev
stream shows Facebook viewers and followers in the stats bar.

## Phase 4: the switch

### S11: App Review, the public switch, acceptance

- **Review package** (owner-led, agent-prepared): a test build with reviewer
  instructions, one screencast per permission (connect → Page picker → Go
  Live → the live on the Page → a comment read → Thank in chat as the Page
  → Stop), privacy policy and data-deletion URLs, data-use answers.
- After approval: Advanced Access, then Access Verification (about 5 days).
- **The switch:** remove the `VIDEORC_BUNDLED_FACEBOOK_OAUTH_ENABLED` gate
  (as `7abac23a` did for YouTube), move the Facebook names into
  `RELEASE_BUNDLED_OAUTH_ENV`, and set the secrets for the next release on
  all three platforms. Same day, a web
  PR updates the marketing lists (`lib/marketing/destination-marks.ts`,
  `official-brand-icon.tsx`, the multistream guide, FAQ).
- **Packaged acceptance** in `docs/acceptance/<date>-facebook-live.md`:
  stream key to a Page; connected mode with Facebook, YouTube and Twitch at
  once; title shown, public only after our push, comments both ways,
  viewers and followers, Stop leaves a VOD; dual orientation sends the
  horizontal leg; an eligibility refusal reads clearly.

## Out of scope

- Profiles in connected mode (D5), Groups, Events.
- Scheduled Facebook lives (belongs with plan 045).
- Vertical or above-1080p Facebook output.
- Commenter avatars (a second Meta review).
- Reactions, Page webhooks, crossposting.
- LinkedIn (owner, 2026-09-30).

## Risks

- **Meta review time** sets the public date (4 to 8 weeks). Phase 1 gives
  users Facebook now.
- **Device login may not grant Page permissions.** Then option B, and the
  privacy page changes.
- **Eligibility** (60 days, 100 followers) blocks small creators in both
  modes. Clear copy is all we can do.
- **Drops:** Facebook may end a live on a short drop. We say so and never
  re-create a live on our own.
- **Contract caps and silent defaults:** S1's derived cap and the
  `oauthUnavailableReason` / `metadataPlatformLabel` fixes cover the known
  traps; their tests keep them covered.
- **Eager bundle:** about 5 KB of gzip headroom. The icon and labels must
  fit; everything connected-mode is lazy.

## Sources (checked 2026-10-27)

- Live Video API, streaming guide:
  https://developers.facebook.com/documentation/live-video-api/guides/streaming
- Page live_videos reference (v26.0):
  https://developers.facebook.com/docs/graph-api/reference/page/live_videos/
- Groups API removal: https://support.restream.io/en/articles/9041527-facebook-groups-api-changes
  and https://ecamm.com/blog/facebook-groups-to-discontinue-third-party-access/
- Plan 079's source list (permissions, tokens, device login, data deletion,
  App Review, rate limits, retention): `origin/feat/079-facebook-live`,
  `plans/079-facebook-live.md`, "Sources".
