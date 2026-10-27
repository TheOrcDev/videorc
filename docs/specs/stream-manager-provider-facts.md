# Stream Manager: provider facts (plan 055, S0)

Checked 2026-09-24 against each platform's official API reference.

The payloads the parsers consume are saved as fixtures in
`scripts/fixtures/stream-manager/`, shaped exactly as the references describe
them. The Rust tests replay them: `twitch_chat.rs`, `youtube_chat.rs`,
`storage.rs` and `audience.rs`.

Confirmation on the owner's real accounts belongs to live acceptance (S14).
Until then, each row below is doc-verified, not account-verified.

## Twitch

| Question | Answer | Source |
| --- | --- | --- |
| Follower total with today's token (no `moderator:read:followers`) | **Yes.** "Only the total follower count will be included in the response"; the `data` list is empty without the scope or the broadcaster or moderator role. | Helix Get Channel Followers |
| Follow events | Need `moderator:read:followers` (`channel.follow` v2, condition `broadcaster_user_id` + `moderator_user_id`). Opt-in reconnect (S6), offered in Activity as "Show who followed" and requested by default on a first connection (plan 071). A grant mid-stream is picked up on the open socket within about 30 s. The event has `user_id`, `user_login`, `user_name`, `followed_at` and no avatar: the connector backfills it from Helix `GET /users`. | EventSub subscription types |
| Subscriber total and points | Need `channel:read:subscriptions` (Get Broadcaster Subscriptions: `total`, `points`). Opt-in reconnect (S6). | Helix reference |
| Sub, resub, gift, community gift, raid, announcement details | **Delivered today** by `channel.chat.notification` under `user:read:chat`.<br>Per notice: `sub` {`sub_tier`, `is_prime`, `duration_months`}; `resub` {`cumulative_months`, `streak_months`, `sub_tier`, `is_prime`, `is_gift`, gifter fields}; `sub_gift` {`recipient_user_*`, `sub_tier`, `community_gift_id`}; `community_sub_gift` {`id`, `total`, `sub_tier`, `cumulative_total`}; `raid` {`user_*`, `viewer_count`, `profile_image_url`}; `announcement` {`color`}.<br>Top level: `chatter_is_anonymous`, `system_message`. | EventSub `channel.chat.notification` |
| Watch streaks (plan 151) | **Delivered today** by `channel.chat.notification` under `user:read:chat`, as `notice_type` `watch_streak` with `watch_streak` {`streak_count`, `channel_points_awarded`}. Twitch's sentence is `system_message`; the viewer's own words are `message.text` / `message.fragments`, the same as on a sub or resub. The other notice types we do not read (`modiversary`, `bits_badge_tier`, `charity_donation`, `gifted_drops_summary`, `shared_chat_*`) stay plain system rows. | [EventSub reference](https://dev.twitch.tv/docs/eventsub/eventsub-reference/), Channel Chat Notification |
| Links in chat (plan 151) | No platform sends a link fragment: Twitch fragments are text, emote, cheermote, mention and, since 2026-07-16, gif (plan 155); YouTube, Kick and X send plain text (X links arrive as `t.co`). The Stream Manager finds links itself (`lib/chat-links.ts`). | EventSub `channel.chat.message`; each platform's chat payload |
| GIFs (plan 155) | **Delivered today** by `channel.chat.message` under `user:read:chat` as a fragment of `type: "gif"` (EventSub changelog 2026-07-16; the GIF Keyboard launched 2026-09-01 for Tier 2 and Tier 3 subscribers, 30 s cooldown, G and PG ratings, streamer can disable it). `text` is the GIPHY title in brackets (`[Y A Y Yes GIF]`); `gif` carries the id and a `url` Twitch requires to be used unmodified. The asset host is **unverified until the owner captures a real fragment (S0)**: `twitch_chat.rs` keeps the URL only on `giphy.com` or `static-cdn.jtvnw.net`, else the row keeps the title and one warn line names the host. The backend never fetches the GIF; the Stream Manager window does, through main's `chat-gifs:cache`. | [EventSub changelog](https://dev.twitch.tv/docs/change-log/), Channel Chat Message; Twitch blog, GIF Keyboard |
| Replies, first-time chat, cheers | **Delivered today** by `channel.chat.message`: `reply` {`parent_message_id`, `parent_message_body`, `parent_user_name`, …}, `message_type` (`user_intro` marks a first-time chatter's intro), `cheer` {`bits`}. | EventSub `channel.chat.message` |

## YouTube (verification builds only)

YouTube OAuth stays off in public builds until Google approves Videorc
(`oauth.rs`).

| Question | Answer | Source |
| --- | --- | --- |
| Super Chat | `superChatDetails` {`amountMicros` (unsigned long), `currency`, `amountDisplayString`, `userComment`, `tier`}. Google serializes unsigned longs as JSON strings; the parser accepts either. | liveChatMessages resource |
| Super Sticker | `superStickerDetails` {`superStickerMetadata.altText`, `amountMicros`, `currency`, `amountDisplayString`, `tier`} | same |
| Memberships | `newSponsorDetails` {`memberLevelName`, `isUpgrade`}, `memberMilestoneChatDetails` {`memberMonth`, `memberLevelName`, `userComment`}, `membershipGiftingDetails` {`giftMembershipsCount`, `giftMembershipsLevelName`}, `giftMembershipReceivedDetails` {`memberLevelName`, `gifterChannelId`, …} | same |
| Subscriber count | `channels.list` `part=statistics` `mine=true` → `subscriberCount` (may be hidden: `hiddenSubscriberCount`), under the granted `youtube.force-ssl` | channels resource |
| Follow events | No API | n/a |

## X

| Question | Answer | Source |
| --- | --- | --- |
| Follower count | `GET /2/users/me?user.fields=public_metrics` → `public_metrics.followers_count`. It accepts OAuth 2.0 user context (`users.read` + `tweet.read`, both already granted) or OAuth 1.0a user context (the "Authorize X Live" token). | X API users/me |
| Follow events | **XAA `follow.follow`** (checked 2026-09-28, plan 071). The `direction: inbound` qualifier fires when someone follows the filtered user; `payload.source.data` is the follower (`id`, `username`, `name`, `profile_image_url`) and `payload.target.data` the followed user. The documented sample is an outbound follow (its filter user is the source). Create-subscription accepts OAuth 1.0a user context, OAuth 2.0 user context (`tweet.read` covers `follow.*`) and app bearer, but the docs list `follow.follow` as neither public nor private, so the auth the desktop uses is **unverified until the first owner stream** (plan 071 S0/S4 gate). Videorc subscribes with an `expires_at` two hours ahead and re-posts it every 30 minutes while live, so follows stop reaching the relay soon after a stream. | X Activity API introduction, event payloads, create subscription |
| Tips, moderation | No API for broadcast chat. X broadcast chat has no delete or ban endpoint in the public reference. | X API reference |

## Kick (plan 063)

Checked 2026-09-25 against docs.kick.com. Scopes: `user:read channel:read
channel:write chat:write streamkey:read events:subscribe`.

| Question | Answer | Source |
| --- | --- | --- |
| Stream key and ingest | `GET /public/v1/channels` (no params, user token) → `stream.url` and `stream.key` (the key needs `streamkey:read`). Videorc stores the key as a secret at Go Live (`kick.rs`). | Channels |
| Title and category | `PATCH /public/v1/channels` {`stream_title`, `category_id`, `custom_tags`} → 204, under `channel:write`. Categories from `GET /public/v2/categories?q=` (v1 `/public/v1/categories?q=` fallback). | Channels, Categories |
| Viewer count | `stream.viewer_count` on the same channel read, polled every 30 s by the viewer sampler (`viewer_stats.rs`); 0 while `stream.is_live` is false. | Channels |
| Chat | Read via Kick webhooks (`chat.message.sent`) relayed by videorc-web (`/api/desktop/kick-chat`, long-poll); send via `POST /public/v1/chat` under `chat:write` (500 graphemes, 2,048 bytes, 429 on limit). The desktop creates the `chat.message.sent`, `livestream.status.updated` and `channel.followed` webhook subscriptions with the user token (`events:subscribe`) at Go Live, stores their ids in the secret store (`platform:kick:{account}:event-subscriptions`), and deletes them at stream end and on disconnect (`kick_chat.rs`). | Events, Chat |
| Followers | No total in the channel read. `channel.followed` relay events arrive as named follow rows in Activity, with the follower's `profile_picture` as the avatar since plan 071 (relay `followerAvatarUrl`) and count up the `stream-audience` row, which reports `capability: "delta-only"` (new follows since the stream started, never a total). No subscribers or tips. | Events |

## Facebook (plan 206)

Stream key only until Meta approves Page sign-in (plan 206, Phases 2 to 4).
Facebook has a live API, but none of it works from a pasted key, so the
Stream Manager treats a Facebook destination like TikTok and Instagram:
its comments row says sign-in isn't available yet, and there are no viewers,
followers or title.

| Question | Answer | Source |
| --- | --- | --- |
| Stream key and ingest | The streamer copies the key from Live Producer (`facebook.com/live/producer`, Streaming software). "Persistent stream key" under Advanced Settings makes it reusable; one live at a time per persistent key. RTMPS only: Live Producer shows `rtmps://live-api-s.facebook.com:443/rtmp/` (the card's default), OBS lists `rtmps://rtmp-api.facebook.com:443/rtmp/`. | Facebook Help 587160588142067; OBS `services.json` |
| Going public | The stream arrives as a preview; the streamer presses Go live in Live Producer. Videorc reminds them in the Go Live dialog. | Facebook Help 587160588142067 |
| Who can go live | Since 2024-06-10: the account is 60+ days old, and a Page or professional-mode profile has 100+ followers. Applies to streaming software too (a refused key is a "permissions error" at the encoder). | Facebook Help 1636872026560015; vMix KB 369 |
| Output | H.264, key frame every 2 s, AAC 48 kHz, at most 1080p60 (OBS's matrix: 1080p60 up to 9,000 kbps). Videorc's shared non-YouTube cap of 1080p / 6,000 kbps applies; 60 fps is allowed. OBS caps audio at 128 kbps for Facebook; Videorc's stream audio is 160 kbps AAC. The owner's first live take checks Live Producer raises no audio warning. | OBS `services.json`, Live Video API guide |
| Chat, viewers, followers, title | None with a key. A connected Page gets them through the Live Video API (plan 206 S8 to S10). | Live Video API |
| Retention | Facebook deletes lives after 30 days unless saved (since 2025-02). The local recording is the archive. | Meta newsroom 2025-02 |

## TikTok, Instagram, custom RTMP

These have no public live chat, viewer or follower API, and Videorc uses manual
stream keys for them. The Stream Manager says so rather than showing zeros.
