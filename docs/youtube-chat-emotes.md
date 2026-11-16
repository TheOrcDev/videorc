# YouTube chat emotes

Stream Manager renders YouTube's built-in named emotes using the existing
rich-message fragments and local image cache. The regression is a message by
`@vcode_sh` whose body is `:face-blue-smiling:`: YouTube shows its blue face,
but Videorc previously showed the alias.

## Provider evidence and coverage

The supported connector uses YouTube Data API v3 `liveChat/messages` (both
list and stream delivery normalize through `youtube_chat::normalize_item`).
The [official resource schema](https://developers.google.com/youtube/v3/live/docs/liveChatMessages)
defines `snippet.displayMessage` as the displayed string and
`snippet.textMessageDetails.messageText` as the user's message. It does not
define emoji runs, custom emoji IDs, image URLs, or a channel-member emoji
catalog. This was checked against the documentation on 2026-11-16.

Three cases are deliberately different:

- Unicode emoji, including skin tones, flags and joined sequences, stay
  untouched in the text and use the system font.
- Built-in YouTube named emotes are matched against the pinned 122-entry
  catalog. Matching is case sensitive and requires the complete colon-delimited
  alias. Adjacent/repeated emotes and emotes touching text work; partial names,
  ordinary bare words, and aliases inside URL-shaped words stay text.
- Channel-member custom emotes cannot be resolved from this API's text alone.
  Unknown aliases (including `:_memberCustom:`) stay readable. No member-emote
  coverage is claimed. Different channels can reuse names for different images;
  guessing from another channel's catalog would be incorrect.

YouTube's public web client uses a different, undocumented rich representation:
its `emoji` objects contain `emojiId`, `shortcuts`, image thumbnails and sometimes
`isCustomEmoji`. The flag is also true for YouTube built-ins, so it does not by
itself identify channel-member emotes. Anonymous public page metadata inspected
during investigation confirmed this distinction. Videorc does not call those
web endpoints or scrape chat pages at runtime.

The public first-party Unicode catalog
[`emojis-png-15.1.json`](https://www.gstatic.com/youtube/img/emojis/emojis-png-15.1.json),
advertised by YouTube's web client, contains Unicode mappings, not
`:face-blue-smiling:`. It is not used to replace Unicode or normal prose.

## Catalog provenance, version and rights

`crates/videorc-backend/assets/youtube-emotes.tsv` contains only alias/URL
metadata, with no downloaded images or third-party implementation code.
It is a pinned snapshot of the global (no channel parameter)
[ytEmojiDB endpoint](https://realityripple.com/Tools/ytEmojiDB/read.php), whose
[documentation](https://realityripple.com/Tools/ytEmojiDB/) describes its
YouTube picker metadata source. Retrieved 2026-11-16; upstream supplies no
release/version identifier. SHA-256 of the retrieved JSON:

`38445fd324d040aecc8f7ccea05db349ad624737ef69cc21ebad8b5d3b958c5a`

Each image identifier is pinned to YouTube's own `https://yt3.ggpht.com/`
thumbnail URL with its observed `=w48-h48-c-k-nd` sizing suffix. All 122 URLs
were fetched successfully and verified as PNGs during this change. Three
independent first-party web message runs (`:shelterin:`,
`:face-red-heart-shape:`, `:cat-orange-whistling:`) matched the snapshot's image
identifiers exactly. The blue-face PNG was visually compared with the supplied
screenshot; its SHA-256 is:

`cbc640142dafcd68630f13551cc219ac3b4332940dcba6ee20f05baf5dfc950f`

This is factual interoperability metadata, not an artwork license. The database
page does not state an explicit data license, and no open license for YouTube's
emote artwork is asserted. Artwork remains the property of YouTube/its respective
creators, is fetched from the provider CDN, and is not redistributed in the repo
or app bundle. Videorc's AGPL license does not relicense those remote images.

Updates must be reviewed snapshots: retain provenance/date/hash, confirm aliases
and images against YouTube, and verify every added URL. Never construct arbitrary
asset URLs from viewer text or silently load a mutable third-party catalog at
runtime. Retired, changed or newly introduced emotes may require a catalog update;
the failure behavior is readable alias text.

## Data path and security

`youtube_chat::normalize_item` calls the pure `youtube_emotes::tokenize` helper
and emits the existing `LiveChatMessageFragment { type, text, imageUrl }` shape.
`messageText` remains verbatim. The connector feeds the existing delivery,
persistence and event path. 7TV decoration preserves existing image fragments
and can still enrich the remaining text. Shared Rust/TypeScript protocol shapes
are unchanged; no renderer-wide alias replacement affects Twitch, Kick or X.

Stream Manager's `CommentRow` groups the fragments and uses its existing `Emote`
component: `useCachedAvatar` -> main's `cacheChatAvatar` -> the allowlisted,
deduplicated, bounded avatar cache -> `videorc-asset://avatar/...`. No new host
is allowed; YouTube's `yt3.ggpht.com` was already trusted for avatars. Viewer
text cannot choose an image URL. React text nodes escape HTML. Images retain
the alias as alt/title, the existing 20px inline height/baseline and natural
width, with text fallback while uncached, refused, offline, or undecodable.

Existing cache behavior applies: at most 1,000 files / 256 MiB, the existing
per-image size/deadline bounds, URL-hashed filenames, and pruning. It does not
refresh immutable URLs on a TTL. Previously persisted text-only messages are
not retroactively rewritten; newly normalized provider deliveries get fragments.

The shared emote decode-failure fallback also improves Twitch, Kick and 7TV
images. This change does not alter recording, live-session lifecycle, provider
accounts, or chat sending. Rich fragments reach other existing consumers, but
no new on-stream, phone-remote, or real-provider coverage is claimed here.

## Focused verification

The exact provider payload and normalized fragment fixture is
`scripts/fixtures/stream-manager/youtube-chat-emotes.json`. The Rust adapter
test checks its normalization; the desktop component test checks its cache
request, image/accessibility markup, mixed content and failure fallback.

The pure production parser can be tested without building the backend:

```sh
rustc --edition=2024 --test crates/videorc-backend/src/youtube_emotes.rs -o /tmp/videorc-youtube-emotes-tests
/tmp/videorc-youtube-emotes-tests
```

Run the focused desktop tests from `apps/desktop`:

```sh
node_modules/.bin/vitest run src/renderer/src/components/comment-row-youtube-emotes.test.ts src/renderer/src/components/comment-row.test.ts src/renderer/src/lib/chat-emotes.test.ts src/main/youtube-emote-cache.test.ts src/main/avatar-cache.test.ts
```

Full backend compilation/adapter execution, smoke tests, managed integration,
device tests and production builds were intentionally deferred under the session
restriction. Before merge/release, run the broader gates when authorized; the standalone parser tests do not replace adapter compilation.
