# Discord go-live announcement

Plan 187 ([issue #634](https://github.com/TheOrcDev/videorc/issues/634)). The
streamer pastes a Discord webhook URL in **Livestream → Setup → Discord**, one
per server, up to ten. After that, every public Go Live posts one message to
each of those channels:

- it is sent under the streamer's name and avatar;
- it carries the stream title and the stream thumbnail;
- it has a link button for each live destination;
- it pings the role the streamer chose.

The message updates itself as more destinations come up, and turns into
"Was live · 1h 42m" at the stop. Every server gets the same post: the
choices below (the switch, Post as, Ping, the footer, the links) apply to all
of them, while each webhook keeps its own secret, its own last message and
its own failure. The feature is free.

Code: `crates/videorc-backend/src/discord_announce/` (the backend owns
everything), `components/streaming/discord-section.tsx`,
`hooks/use-discord-announce.ts` and `lib/discord-announce.ts` in the renderer.

## When it posts

A session is announced when it has destinations, the feature is on
(**Announce when I go live**), and at least one webhook is saved. The post is
composed once at Go Live and each saved webhook runs its own copy of the
session (its own state machine), so every server sees the same facts.

### Which destinations are linked

The **Links in the post** list shows every configured destination and the
link it will post:

| Link        | Where it comes from                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto        | Built from the connected account: `twitch.tv/{login}`, `kick.com/{slug}`, or `youtube.com/@{handle}/live` for a YouTube stream key. YouTube resolves `/live` only while a public stream runs. |
| At Go Live  | YouTube (signed in): `youtube.com/watch?v={broadcast}`. X: its share link.                                                                                                              |
| Typed       | Any `https` link the streamer types, at most 512 characters. A typed link wins over the other two.                                                                                     |
| None        | Nothing known, for example TikTok, Instagram, Custom RTMP or a stream key with no account. The row can't be switched on until a link is typed.                                         |

Every destination is included by default. The backend stores the switched-off
ones (`excludedTargetIds`), so a new destination is included automatically.

### When a destination counts as live

The backend marks a destination live as soon as FFmpeg starts, so each
platform needs its own proof:

- **YouTube (signed in)**: `streamTargets.youtube.transition` to live
  succeeded. The transition's `part=status` answer carries YouTube's own
  `privacyStatus` at no extra quota cost. If it is missing, the draft's YouTube
  privacy is used. Only `public` is announced; unknown counts as not public.
- **X**: `streamTargets.x.publish` returned the share link. X has no unlisted
  or private, and `x_announce` only suppresses X's own post.
- **Every other platform**: the destination stayed `live` in `stream.targets`
  for 10 s. A dip (`reconnecting`, `warning`, `failed`) restarts the 10 s. It
  never takes a posted link back.

### Posts and edits

- **The first post** goes out when the first switched-on destination is
  confirmed live.
- **Later destinations** are added in one edit, gathered over 2 s.
- **The stop** sends one edit: the content becomes "Was live: {title} ·
  {duration}", the colour turns grey and the buttons stay.
- **Never a "Live now" after the stop.** A post still retrying when the
  session ends gives up. A post that lands after the stop is edited to "Was
  live" at once.
- **Reconnects never post again.** There is one message per session per
  webhook.
- **The restart window.** A Go Live within 15 minutes of the last announced
  session's end edits that webhook's message back to live. It sends no new
  post, and an edit never pings. If that message was deleted in Discord, the
  session posts fresh through that webhook, still only once.
- **A crash or quit mid-stream.** Each webhook's message is remembered in
  `app_settings` (`discord.announce.lastMessage`, a list with one entry per
  webhook; `lastSeenLiveAt` refreshed every 60 s). The next launch waits
  30 s, then edits every message that is still live to "Was live", each
  through its own webhook. A row written before there were several webhooks
  held one object; it still reads.
- **One request at a time per webhook, webhooks side by side.** Requests to
  one server keep their order (an old session's "Was live" edit lands before
  a restart's revive edit), while a slow, rate-limited or deleted webhook
  never delays another server's post.

## The message

```
(avatar) OrcDev                                   ← username / avatar_url (Post as)
@everyone Live now: Building a Discord bot        ← content: the ping lives here
┃ Building a Discord bot                          ← embed title, links to the first destination
┃ [ thumbnail ]                                   ← attachment://thumbnail.png
┃ Live with Videorc · today at 18:02              ← footer (Videorc footer switch) + start time
[ Twitch ] [ YouTube ] [ YouTube · Vertical ]     ← link buttons (with_components=true)
```

- **Ping.** No ping, @here or @everyone. The default is no ping.
  `allowed_mentions` is `{parse: ["everyone"]}` on the live post only. Edits
  and the test message send `{parse: []}`.
- **Post as.** Automatic, any connected account, the Videorc account, or the
  webhook's own name. Automatic picks the first switched-on destination's
  account, then the Videorc account, then the webhook's own name. Discord
  refuses some names (`@ # :`, "discord", "clyde", "everyone", "here"). Videorc
  strips those characters, and if the name is still refused it falls back to
  the webhook's own name.
- **Link buttons.** At most 5 per row and 25 in all. If Discord answers 400
  about `components`, Videorc posts once more without buttons, with the links
  in the embed ("**Watch:** [Twitch](…) · …"). It remembers that for the
  webhook (`componentsRefused`).
- **The thumbnail** is the stream thumbnail from Stream details, sent as a
  multipart attachment. Edits keep it.

## Failures

| Discord answers                | Videorc does                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| 401, or 404 "Unknown Webhook"  | That webhook is gone. It reports `webhook-deleted` on its row and doesn't retry; the others go on.  |
| 404 on an edit                 | The message is gone. It forgets that webhook's message, quietly.                                    |
| 429                            | It waits `retry_after` (at most 60 s), then retries.                                                |
| 5xx, timeout (10 s), offline   | It retries after 2, 5, 15, 30 and 60 s, then every 60 s, for up to 5 minutes. Then it reports `unreachable`. |
| Any other 4xx                  | It reports `rejected`. Discord's code goes to the log, never to the copy.                           |

A failed post raises one neutral toast wherever the streamer is: "Couldn't
post to Discord", with **Open Livestream**; the description names the webhook
("The Stream alerts webhook was deleted in Discord. …") so servers tell
apart, and the newest failure across the webhooks is the one that toasts.
That webhook's row shows the same line, and a health event records it
("Couldn't post to Discord (Stream alerts): …"). A success raises no toast;
the row shows "Last post … · View in Discord".

## Secrets

A webhook URL is a bearer credential.

- It goes in through `discord.webhook.save` and lives only in the secrets
  file, one secret per webhook under `discord.webhook.url.{id}` (`id` is
  Discord's id for the webhook, the number in the URL; it is not a
  credential). A webhook saved before there were several sits under plan
  187's single `discord.webhook.url`; it is read from there until it is
  pasted again or removed, so an upgrade loses nothing and copies nothing.
- The renderer sees each webhook's `id`, Discord's `name` for it and the
  masked tail (`…/a1B2`).
- `WebhookUrl`'s `Debug` prints only the tail. A `reqwest::Error`, whose text
  quotes the URL, is never formatted.
- No RPC is reachable from the remote-control role or the Phone remote
  (default deny, pinned by a test).
- `smoke:discord-announce` checks that no token ever appears in the app log
  or on the renderer socket.

## Settings

`app_settings` key `discord.announce`: `enabled`, `ping`, `branding`,
`postAs`, `excludedTargetIds`, `linkOverrides`, and `webhooks`, a list in the
order they were connected (at most 10), each with Discord's `id`, `name`,
`channelId`, `guildId`, the `hint`, `verifiedAt`, `componentsRefused` and its
own `lastError`. A row from before there were several carries `webhook` and a
global `lastError` instead; they are folded into `webhooks` on read and never
written again.

## RPCs

| Method                     | Policy      | Notes                                                                   |
| -------------------------- | ----------- | ----------------------------------------------------------------------- |
| `discord.announce.get`     | Observation | The snapshot. It never includes the URL.                                |
| `discord.announce.update`  | Mutation    | Every field is optional. `linkOverride` with no `link` removes the typed link. |
| `discord.webhook.save`     | Mutation    | `{ url }`. Checks the format, then Discord verifies it with a `GET`, then it is added. A webhook already saved (same id) is replaced in place; past ten it refuses with `discord-too-many-webhooks`. |
| `discord.webhook.remove`   | Mutation    | `{ webhookId }`. Deletes that webhook's secret, settings and last message; the others stay. |
| `discord.webhook.sendTest` | Mutation    | `{ targets, webhookId }`: a test post through that one webhook. Not `.test`: a name ending in `.test` is admin-only, for smoke sockets. |
| `discord.links.preview`    | Observation | The rows of the links list, and who Automatic resolves to.              |

The event is `discord.announce.changed`, which carries the snapshot.

## Testing

- `cargo test -p videorc-backend discord_announce` runs the unit tests: the
  state machine (dwell, coalescing, reconnects, restarts, privacy), the
  bodies, the URL rules, and the retries against a local axum fake.
- `pnpm smoke:discord-announce` runs the real dev app against
  `scripts/lib/fake-discord-webhook.mjs` (two webhooks, each its own server),
  through the dev-only `VIDEORC_DISCORD_API_BASE_URL` (a loopback origin;
  packaged builds refuse it), with two local RTMP listeners. It proves that
  every post and edit lands on both, that a webhook deleted in Discord never
  blocks the other, and that removing one keeps the other posting.
- Against real Discord, use a webhook in a private test server, never a
  community one. Check four things: the link buttons render, the avatar and
  name are the streamer's, the thumbnail survives the "Was live" edit, and
  @everyone pings only on the live post.
