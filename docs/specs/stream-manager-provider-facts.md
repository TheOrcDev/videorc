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
| Follow events | Need `moderator:read:followers` (`channel.follow` v2, condition `broadcaster_user_id` + `moderator_user_id`). Opt-in reconnect (S6). | EventSub subscription types |
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
| Follow events, tips, moderation | No API for broadcast chat. X broadcast chat has no delete or ban endpoint in the public reference. | X API reference |

## Kick (plan 063)

Checked 2026-09-25 against docs.kick.com. Scopes: `user:read channel:read
channel:write chat:write streamkey:read events:subscribe`.

| Question | Answer | Source |
| --- | --- | --- |
| Stream key and ingest | `GET /public/v1/channels` (no params, user token) → `stream.url` and `stream.key` (the key needs `streamkey:read`). Videorc stores the key as a secret at Go Live (`kick.rs`). | Channels |
| Title and category | `PATCH /public/v1/channels` {`stream_title`, `category_id`, `custom_tags`} → 204, under `channel:write`. Categories from `GET /public/v2/categories?q=` (v1 `/public/v1/categories?q=` fallback). | Channels, Categories |
| Viewer count | `stream.viewer_count` on the same channel read. Planned for S6. | Channels |
| Chat | Read via Kick webhooks (`chat.message.sent`) relayed by videorc-web; send via `POST /public/v1/chat` under `chat:write`. Planned for S4/S5; not in Videorc yet. | Events, Chat |
| Followers | No total in the channel read; `channel.followed` events give deltas only. Planned for S6. | Events |

## TikTok, Instagram, custom RTMP

These have no public live chat, viewer or follower API, and Videorc uses manual
stream keys for them. The Stream Manager says so rather than showing zeros.
