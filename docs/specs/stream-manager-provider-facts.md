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

## TikTok, Instagram, custom RTMP

These have no public live chat, viewer or follower API, and Videorc uses manual
stream keys for them. The Stream Manager says so rather than showing zeros.

## Facebook (plan 079)

Execution started 2026-09-30. Only the stream-key destination is implemented.
Connected Page behavior remains blocked by the owner's Meta setup and the S0
sign-in decision. The facts in plan 079 are research inputs, not live acceptance.
Meta's linked help pages redirected this session to a login/block page, and the
device-login reference returned HTTP 429; neither verifies account behavior.

| S0 probe                                                                       | Result                                            | Consequence                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------- |
| Device login with all five Page permissions, `/me/accounts`, Page-token expiry | Pending owner app and eligible Page               | Option A or B is undecided; Facebook OAuth stays unavailable. |
| Development loopback redirect                                                  | Not tested                                        | No claim that Meta accepts a development loopback callback.   |
| SSE comments, `comment_rate`, returned fields                                  | Not tested                                        | No connected comments connector enabled.                      |
| Push drops for 5/15/30/60 seconds                                              | Not tested                                        | No automatic Facebook broadcast recovery implemented.         |
| 1080p30/60 ingest health at 6 Mbps                                             | Not tested against Facebook                       | Local fan-out checks do not substitute for Meta acceptance.   |
| Live Producer persistent key and browser publish step                          | Plan copy implemented, owner confirmation pending | Setup and Go Live explain the browser publish action.         |

The shipped stream-key mode has no comments, viewers, followers or metadata
API. It uses the existing secure manual-key store and horizontal stream leg.
A connected Page must never be inferred from a pasted key.
