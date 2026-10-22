# Plan 187: Discord go-live announcement

> **Executor instructions**: Follow this plan slice by slice. Run every "Done
> when" check before moving on. If anything in "STOP conditions" happens, stop
> and report; do not improvise. When done, update this plan's row in
> `plans/README.md` and fill in "As built". Gates run once at the end
> (owner rule): write and commit S1–S6 first, then run S7.
>
> **Drift check (run first)**:
> `git diff --stat a53d8837..origin/main -- crates/videorc-backend/src/main.rs crates/videorc-backend/src/usage_stats.rs crates/videorc-backend/src/youtube.rs crates/videorc-backend/src/x_live.rs crates/videorc-backend/src/kick.rs crates/videorc-backend/src/streaming.rs crates/videorc-backend/src/secrets.rs crates/videorc-backend/src/storage.rs crates/videorc-backend/src/oauth.rs crates/videorc-backend/src/account.rs crates/videorc-backend/src/recording.rs apps/desktop/src/shared/backend.ts apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/renderer/src/components/tabs/streaming-tab.tsx apps/desktop/src/renderer/src/hooks/use-studio.tsx`
> If an anchor quoted below has moved, re-find it by the symbol name. If a
> _behaviour_ changed (not just a line number), that is a STOP condition.

## Status

- **Priority**: P2. Community request [#634](https://github.com/TheOrcDev/videorc/issues/634)
  (2026-10-07): "When you go live, it should send a webhook in a configured
  Discord channel. This gives a link to all configured providers." Owner,
  2026-10-22: "it's a good idea", and they settled the product shape in a
  grilling session that day (D1–D14 below).
- **Effort**: M. 7 slices: S1–S6 are code and docs, S7 is the gates and the
  real-Discord check.
- **Risk**: LOW–MEDIUM. Nothing touches capture, encoding or the picture.
  The two risks are:
  - **Go Live latency.** The hooks sit in `session.start`, the YouTube
    transition and the X publish handlers. Each hook only sends a fact into a
    channel and must never `await` network I/O on the go-live path.
  - **Secret leakage.** A Discord webhook URL is a bearer credential: anyone
    holding it can post to the channel. It must never reach the renderer,
    logs, health events, support bundles or the remote surfaces.
- **Depends on**: nothing.
- **Category**: feature (go-live, community)
- **Planned at**: commit `a53d8837` (origin/main), 2026-10-22
- **Route**: Implementation, fit 8. It is a scoped backend service plus one
  UI section, with clear acceptance. Model lanes per slice:
  - `fable-5`: S2 (trigger state machine and go-live hooks). It sits on the
    release-critical Go Live path and reconnects make it subtle.
  - `gpt-5.5`: S1, S3, S5, S6. These cover the sender, contracts, smoke and
    docs, which are mechanical with clear acceptance.
  - `opus-4.8`: S4 (the Discord section). It is taste-heavy UI. Load
    `.claude/skills/videorc-design/SKILL.md` and the shadcn skill first.
  - Escalate to `fable-5` without asking if a by-eye pass comes back below the
    bar.

## Goal

A streamer pastes one Discord webhook URL into the Livestream page once. From
then on, every time they go live publicly, their Discord server gets one
good-looking post within seconds:
- it comes **from the streamer** (their name and avatar);
- it carries the stream title, the stream thumbnail and **one link button per
  live platform they chose**;
- it pings the role they picked;
- it updates itself to "Was live · 1h 42m" when they stop.

Reconnects and quick restarts never ping twice. Test, unlisted and private
streams never get announced.

## What exists today (verified at `a53d8837`)

Paths are under `crates/videorc-backend/src/` or `apps/desktop/src/` unless
stated.

### There is no single "confirmed live" signal

- **Go Live in the renderer**: `confirmGoLive` (`renderer/src/hooks/use-studio.tsx`
  ~14406) runs metadata update, then validation, then
  `prepareOauthTargetsForGoLive`, then `runStartSession`, which sends RPC
  `session.start` (`main.rs:10948`) to `start_session`
  (`recording.rs:3490`). On success the handler already spawns a post-start
  side task, `spawn_session_live_chat` (`main.rs:10961`). That is where the
  start hook goes.
- **The backend marks every destination `Live` as soon as FFmpeg starts**
  (`build_stream_runtime`, `recording.rs:23256-23280`). There is no
  "connecting" stage. `stream.targets` carries a full `StreamTargetsSnapshot
  { session_id, targets: [StreamTargetRuntime { target_id, platform, label,
  state, .. }] }` (`streaming.rs:439-457`).
- **Real platform confirmation exists for two platforms only**, both driven
  from the renderer after the start RPC (`use-studio.tsx:13758-13771`):
  - **YouTube (OAuth)**: the renderer polls `youtube.streamStatus`, then calls
    `streamTargets.youtube.transition` (`main.rs:12087`, then
    `youtube.rs:921 transition_youtube_broadcast`). The request already asks
    for `part=id,status`, and the lifecycle re-read also uses `part=status`
    (`youtube.rs:1037`). So YouTube returns `status.privacyStatus` **for
    free**, but `YouTubeBroadcastStatus` (`youtube.rs:432`) only parses
    `life_cycle_status` today.
  - **X**: `streamTargets.x.publish` (`main.rs:12277`, then
    `publish_x_native_live`) returns `share_url` (`x_live.rs:156/814-868`).
    `XPublishParams` carries `session_id` and `account_id`
    (`x_live.rs:63-75`).
  - **Twitch and Kick** have no confirmation step.
- **Reconnects**: a leg goes `Reconnecting` or `Warning` and back to `Live`,
  re-emitting `stream.targets` (`recording.rs:22973-22992, 23055`). A naive
  "became Live" hook fires twice.
- **`recording.status`** reports `Recording` when you record and stream
  together, and `Streaming` only for stream-only sessions
  (`recording.rs:6216-6220`). Use `session_id` plus the presence of streaming
  targets, not the state name, to know a session is live.

### What we know per destination (for links)

`StreamPlatform` = youtube, twitch, kick, x, tiktok, instagram, custom
(`streaming.rs:18-26`). `StreamTargetSettings` (`streaming.rs:93-129`)
carries `id, platform, label, auth_mode, account_id, platform_broadcast_id,
output_orientation`. The backend receives every enabled target in
`StartSessionParams.streaming` at `session.start`.

| Destination | Auto link | Source |
| --- | --- | --- |
| YouTube OAuth (instant or scheduled) | `https://www.youtube.com/watch?v={broadcastId}` | `platform_broadcast_id`, or the transition's `broadcast_id`. A vertical leg has its own broadcast. |
| YouTube manual key | `https://www.youtube.com/{customUrl}/live` if a YouTube account is connected and `customUrl` starts with `@`, else none | `PlatformAccount.account_handle` = `customUrl` (`oauth.rs:2649-2653`) |
| Twitch | `https://www.twitch.tv/{login}` if the account is connected | `account_handle` = `@login` (`oauth.rs:2670`); strip the `@` |
| Kick | `https://kick.com/{slug}` | `PreparedKickBroadcast.slug` (`kick.rs:107`), else the Kick `account_handle` |
| X | `share_url` | X publish result; known only after publish |
| TikTok, Instagram, Custom | none | — |

Display name and **public avatar URL** for every connected platform account:
`PlatformAccount { account_label, account_handle, avatar_url }` (parsed at
`oauth.rs:2605-2740`). For the Videorc account: `account.rs:223`
(`avatar_url`) plus the display name.

### Stream title, thumbnail, privacy

- `StreamMetadataDraft { title, description, default_privacy,
  target_overrides, thumbnail_asset_id }` (`streaming.rs:293-305`), read with
  `state.database.stream_metadata_draft()` (`storage.rs:6489-6517`).
- The per-platform effective title comes from `preflight.rs:400
  effective_metadata(platform, draft)`.
- The thumbnail is a managed asset id, resolved through
  `resource_authority.resolve_managed_thumbnail` (`main.rs:2900`).
- X has no privacy concept: `x_announce` only suppresses X's own tweet. It is
  not private.

### Patterns to copy

- **Backend side service watching the event bus**: `usage_stats.rs`. It reads
  `recording.status` and `stream.targets` from `state.events.subscribe()`
  (`:164-180, 514-528`), runs a sender task with a persisted queue in
  `app_settings`, retries 408/429 honouring `Retry-After`, uses a 10 s
  timeout, and is spawned at `main.rs:666`. Copy the shape; do not share
  code.
- **Secrets**: a 0600 JSON file next to the database (`secrets.rs:1-14`):
  `put_secret` / `try_get_secret` / `delete_secret` (`:283-346`). Model the
  new secret on the manual stream key: `streamTargets.manualKey.store` /
  `.inspect` (`main.rs:11944/11974`) return only presence plus a masked hint
  (`stream_key_hint`, `streaming.rs:204`).
- **Settings**: the `app_settings` table, through `load_setting` /
  `save_setting` (`storage.rs:6200-6222`).
- **RPC registration**: every new method must be listed in
  `websocket_method_execution_policy` (`main.rs:5393`), mirrored in
  `shared/backend-rpc-contract.ts`, and typed in `shared/backend.ts`.
- **Fake upstreams in smokes**: `smoke:youtube-quota` runs the dev app
  against `scripts/lib/fake-youtube-api.mjs` via the dev-only
  `VIDEORC_YOUTUBE_API_BASE_URL`, which packaged builds refuse.
  `smoke:multistream` already has local RTMP sinks. `smoke:streaming-secrets`
  proves secrets don't leak.
- **Existing Discord code** (Node release tooling, not app code):
  `scripts/notify-discord-release.mjs` (payload with
  `allowed_mentions: {parse: []}`), `scripts/release-announce.mjs`
  (`?wait=true`, message-id reconcile), and `scripts/live-lab/lib/discord.mjs:9`
  (URL regex). Reuse the rules, not the code.

### Discord webhook API (checked 2026-10-22, docs.discord.com/developers/resources/webhook)

- **Execute** `POST /api/webhooks/{id}/{token}`:
  - Query `wait=true` returns the created message, which gives us the
    message id.
  - Query `with_components=true` lets a webhook that is **not** owned by an
    application send *non-interactive* components. Link buttons should
    qualify. **This is unverified against a real webhook; S7 checks it, and
    S1 builds the fallback.**
  - Body: `content` (≤2000), `username`, `avatar_url`, `embeds` (≤10),
    `allowed_mentions`, `components`, `attachments` / `files[n]` /
    `payload_json` (multipart), `flags`.
- **Edit** `PATCH /api/webhooks/{id}/{token}/messages/{message_id}`:
  - Edits `content`, `embeds` and `components` (`with_components=true`).
  - Does **not** accept `username` or `avatar_url`; the sender identity is
    fixed at creation.
  - Existing attachments are kept unless an `attachments` array is sent.
  - Edits never ping.
- **Get** `GET /api/webhooks/{id}/{token}`: no auth needed. Returns `name`,
  `channel_id` and `guild_id` and posts nothing. A 404 means the webhook was
  deleted.
- **Rate limits**: 429 returns JSON `retry_after` (seconds, float).
- **Usernames** must be 1–80 characters. They may not contain `@`, `#`, `:`,
  ```` ``` ```` or `discord`, and may not be `everyone` or `here`.

## Owner decisions (2026-10-22, grilling session)

- **D1 Discord only, one webhook.** There are no generic webhooks and no
  Slack or Telegram. The code is shaped so that "announcement targets" could
  be added later without a rewrite.
- **D2 Free.** No `FeatureId`, no gate.
- **D3 Automatic.** Once it is configured and switched on, every qualifying
  Go Live posts. A master switch, **Announce when I go live**, sits in the
  Discord section. Nothing new goes beside Go Live (owner rule: simple
  actions, not Studio switches).
- **D4 Ping picker: No ping / @here / @everyone, default No ping.** There are
  no role pings in v1, because they need Developer Mode to copy the role ID.
- **D5 Branding on by default, with a switch.** The embed footer reads "Live
  with Videorc" (videorc.com icon if available), and **Show "Live with
  Videorc"** turns it off.
- **D6 Setup flow:**
  1. Format check while typing.
  2. On save, `GET` the webhook to verify it and show its name.
  3. Store the URL as a secret and show only a masked tail.
  4. A **Send test message** button.
- **D7 Post and edit:**
  - Post as soon as the first ticked destination is confirmed live.
  - Edit the message to add buttons as more ticked destinations confirm.
  - Edit it to "Was live · {duration}" when the session ends.
  - One message per session. Reconnects never post again.
  - A session that stops before any ticked destination is confirmed posts
    nothing.
- **D8 Destination checklist (opt-out):**
  - The Discord section lists the configured destinations, each with the
    link it will post.
  - The link is filled in automatically where Videorc can build it and can
    be typed where it can't (for example `twitch.tv/name` for a stream-key
    Twitch, or `tiktok.com/@name/live`).
  - A row with no link can't be ticked until a link is typed.
  - Everything is ticked by default. Settings store **exclusions**, so a new
    destination is included automatically.
  - The trigger follows the selection: the post waits for the first
    **ticked** destination. If no ticked destination is in the session,
    nothing is posted.
- **D9 Public only.**
  - Unlisted and private YouTube legs are skipped. If nothing is left,
    there's no post.
  - The section says: "Unlisted and private YouTube streams are never
    announced."
- **D10 Where it lives.** A new **Discord** section on the Livestream page,
  after Stream details, described as "Tell your server when you go live."
- **D11 The message:**
  - A plain-text line (push notifications show only this) with the ping and
    "Live now: {title}".
  - An embed with the title (linking to the first live destination), the
    stream thumbnail if one is set, the branding footer and the start
    timestamp.
  - **No description.**
  - **One link button per live, ticked destination.** If Discord refuses
    components, the links go in the embed instead.
- **D12 Sent as the streamer.**
  - The webhook's `username` and `avatar_url` are overridden per message.
  - A **Post as** picker lists connected platform accounts plus the Videorc
    account. Its default is **Automatic**: the account of the first ticked
    destination, then the Videorc account, then the webhook's own identity.
- **D13 Failure handling:**
  - Retry for up to 5 minutes (honour 429 `retry_after`, back off on
    5xx/network). Never post after the session ended.
  - On final failure: one neutral toast (the type colours the icon only),
    "Couldn't post to Discord: {reason}", with an **Open** action; the same
    error on the webhook row; a health event.
  - **No success toast.** The section shows "Last post: {time} · View in
    Discord" instead.
  - No Buddy voice and no chat command.
- **D14 Restarts and crashes:**
  - **Restart window**: a session that goes live within **15 minutes** of the
    previous announced session ending edits that message back to live, with
    no new post and no new ping.
  - **Crash or quit mid-stream**: the next launch edits a still-live message
    to "Was live".
  - If the message was deleted in Discord or the webhook changed, the edit
    fails quietly and the next Go Live posts fresh.

## Design

### Engineering decisions (planner's, not owner questions)

- **E1 The backend owns everything.** A new module, `discord_announce.rs`,
  holds the settings, the secret, link building, the trigger state machine
  and the sender. The renderer only edits settings and renders snapshots. It
  never sees the webhook URL after the paste RPC.
- **E2 "Confirmed live" per leg:**
  - YouTube OAuth: `streamTargets.youtube.transition` to `Live` succeeded.
  - X: `streamTargets.x.publish` returned a share URL.
  - Every other platform: the leg has been continuously `Live` in
    `stream.targets` for **10 s** (`CONFIRM_DWELL`). A dip to `Reconnecting`,
    `Warning` or `Failed` resets that leg's dwell; it does not un-post.
- **E3 YouTube privacy source:**
  - Parse `status.privacyStatus` into `YouTubeBroadcastStatus` (both the
    transition and the lifecycle re-read already request `part=status`, so
    there is **no new quota**). Carry it on `YouTubeBroadcastTransitionResult`
    as `privacy_status: Option<StreamPrivacy>`, with `#[serde(default,
    skip_serializing_if = "Option::is_none")]` (serde null trap, see
    STOP).
  - If it is missing, fall back to the draft's YouTube override or
    `default_privacy`. If that is still unknown, **skip the leg**
    (fail-safe).
  - YouTube manual-key `/@handle/live` links need no privacy check: YouTube
    resolves `/live` only for a public live stream.
- **E4 Hooks never block.** The three hooks (session start, YouTube
  transition, X publish) each `try_send` a `Fact` on a bounded mpsc channel to
  the announcer task. If the channel is full they drop and log (no URL). The
  event-bus observer handles `stream.targets` and `recording.status`.
- **E5 One pure state machine.** `AnnounceSession` takes `Fact`s and `now`
  and returns `Action`s (`Post`, `Edit`, `Nothing`). All timing (dwell, edit
  debounce, the restart window) is inside it, with an injected clock, and it
  is unit-tested without the network.
- **E6 Edit pacing.** Coalesce edits for **2 s**, and never send more than one
  request per second per webhook. The final "Was live" edit always wins over
  a pending edit.
- **E7 The test message never pings.** It sends `allowed_mentions: {parse:
  []}`, and the chosen ping appears in the text as inline code ("Your real
  post will ping `@everyone`"). It is labelled "Test from Videorc". It uses
  the real title, avatar, thumbnail and current links (YouTube OAuth and X
  show example links, because their real links don't exist until Go Live).
- **E8 Dev-only fake.** `VIDEORC_DISCORD_API_BASE_URL` (debug builds only;
  packaged builds refuse it and log once) rewrites the scheme and host of the
  stored webhook URL, so the smoke can use a local fake. The format
  validator accepts `http://127.0.0.1:{port}/api/webhooks/{id}/{token}`
  only while that variable is set in a debug build.
- **E9 Persistence:**
  - Secret `discord.webhook.url` (the full URL).
  - `app_settings` key `discord.announce` holds the non-secret settings:
    `enabled, ping, branding, postAs, excludedTargetIds[], linkOverrides{targetId: url}`
    plus the verified `webhookName, guildId, channelId, webhookId, verifiedAt`
    and `lastError`.
  - `app_settings` key `discord.announce.lastMessage` holds the one in-flight
    or last message: `webhookId, messageId, channelId, guildId, sessionId,
    startedAt, lastSeenLiveAt, endedAt?, state(live|ended),
    thumbnailAttached`. `lastSeenLiveAt` is refreshed every 60 s while live,
    so crash recovery can compute a duration.
- **E10 Linkable rows preview.** A new `discord.links.preview` RPC takes the
  renderer's current destinations (`id, platform, authMode, accountId,
  outputOrientation, label`) and returns, for each, an auto link, a
  "made at Go Live" marker (YouTube OAuth, X), or "no link". The backend's
  link builder is the only implementation; the renderer never builds URLs.

### The message

- **Live post**:
  - `content`: `{ping }Live now: {title}`. With no title, use `{name} is live
    now`, or just `Live now`.
  - `username` / `avatar_url`: the **Post as** identity.
    - Sanitize the username against Discord's rules. If it is still invalid,
      omit it so the webhook's own name is used.
    - Use `avatar_url` only if it is `https`.
  - `embeds[0]`:
    - `title` is the stream title, truncated to 256 characters. Its `url` is
      the first live ticked link.
    - `color` is `0xEF4444` while live.
    - `image.url` is `attachment://thumbnail.{ext}` when a thumbnail is set,
      sent as multipart `files[0]`. Skip the image if the file is over
      8 MB.
    - `footer` is `{text: "Live with Videorc", icon_url}` when branding is
      on.
    - `timestamp` is the session start.
  - `components`: action rows of link buttons (`type: 2, style: 5, label,
    url`), at most 5 per row. Labels are the platform name ("YouTube",
    "Twitch", "Kick", "X", "TikTok", "Instagram", or the custom
    destination's label); a vertical-orientation leg gets " · Vertical".
  - `allowed_mentions`: `{parse: ["everyone"]}` when the ping is @here or
    @everyone, else `{parse: []}`.
- **Fallback when Discord refuses components** (a 400 that names
  `components`):
  - Resend once without components, and add the links to the embed
    `description` as `**Watch:** [Twitch](…) · [YouTube](…)`.
  - Remember `componentsRefused: true` for this webhook, so later posts use
    the fallback directly.
- **Added-leg edit**: the same body with more buttons. It sends no username
  or avatar, and keeps the attachment by sending `attachments: [{id}]` with
  the same `attachment://` image reference.
- **Ended edit**:
  - `content`: `Was live: {title} · {duration}` (for example "1h 42m",
    "42m", or "under a minute").
  - The embed colour turns `0x71717A`, the footer reads "Streamed with
    Videorc" when branding is on, and the buttons stay.
  - A crash-recovered message whose duration is unknown omits the duration.
- **Restart-window edit**: back to the live body with the new session's
  links, and no ping (edits never ping).

### Trigger walk-through

1. **`session.start` OK, with streaming targets.** A `SessionStarted` fact
   carries the session id, the start time, each enabled target (`id,
   platform, label, auth_mode, account_id, platform_broadcast_id,
   orientation`), the draft's title/privacy/thumbnail, and the Discord
   settings snapshot. The announcer resolves each leg to one of:
   - **Excluded**: unticked by the user.
   - **NoLink**: no auto link and no typed link.
   - **NotPublic**: YouTube OAuth whose privacy is already known as
     non-public.
   - **Pending**: everything else.
   If no leg is Pending, or the feature is off, or there's no webhook, it is
   done for this session.
2. **A leg confirms** (E2). Its link becomes final: YouTube OAuth by
   broadcast id, X by share URL. The YouTube privacy check runs now
   (E3). The first confirmed Pending leg triggers either a **Post**, or an
   **Edit** of the previous message if the restart window applies (D14).
   Later confirmed legs trigger debounced **Edits**.
3. **The session ends** (`recording.status` goes idle/stopped for that
   session id). If a message exists, an **ended Edit** is sent. Pending
   retries for a post are cancelled: there is never a "Live now" after the
   stop.
4. **App launch.** After a 30 s startup delay, if `lastMessage.state ==
   live` and no session is running, send an ended Edit with duration
   `lastSeenLiveAt - startedAt`.

### Failure handling

| Response | Behaviour |
| --- | --- |
| 2xx | Store the message id (post) and update `lastMessage` / the "Last post" snapshot. |
| 404 / 401 on POST | The webhook is gone. Set `lastError = webhook-deleted`, emit a failure toast once, and do not retry. |
| 404 on PATCH | The message was deleted. Drop `lastMessage`. Quiet: no toast, debug log only. |
| 429 | Wait `retry_after` (capped at 60 s), then retry. |
| 5xx / network / timeout (10 s) | Back off 2 s, 5 s, 15 s, 30 s, 60 s and so on, until 5 minutes have passed since the first attempt. Then `lastError = unreachable` plus a toast. |
| 400 naming `components` | Component fallback (above). |
| Other 400 | `lastError = rejected`, a toast, and log the status plus Discord's `code` (never the URL or the body we sent). |

Every outcome emits a health event ("Discord announcement posted / failed:
{reason}"). None of them contains the URL.

### Wire shape

RPCs (Rust handler, `websocket_method_execution_policy`,
`backend-rpc-contract.ts`, `backend.ts`):

| Method | Policy | Params | Result |
| --- | --- | --- | --- |
| `discord.announce.get` | Observation | — | `DiscordAnnounceSnapshot` |
| `discord.announce.update` | Mutation | partial `{enabled, ping, branding, postAs, excludedTargetIds, linkOverrides}` | snapshot |
| `discord.webhook.save` | Mutation | `{url}` | snapshot, or the typed error `discord-invalid-url` / `discord-webhook-not-found` / `discord-unreachable` |
| `discord.webhook.remove` | Mutation | — | snapshot (deletes the secret and `lastMessage`) |
| `discord.webhook.sendTest` | Mutation | `{targets}` (as for preview) | `{ok, messageUrl?}` or a typed error |
| `discord.links.preview` | Observation | `{targets: [...]}` | `[{targetId, link?, linkKind: auto|typed|at-go-live|none, reason?}]` |

Event `discord.announce.changed` carries the snapshot. The renderer
refreshes the section from it and raises the failure toast when
`lastError` changes to a new value during a session.

```ts
interface DiscordAnnounceSnapshot {
  webhookPresent: boolean
  webhookHint?: string          // "…/a1B2", the last 4 characters of the token
  webhookName?: string
  enabled: boolean
  ping: 'none' | 'here' | 'everyone'
  branding: boolean
  postAs: { kind: 'automatic' } | { kind: 'platform'; accountId: string } | { kind: 'videorc' } | { kind: 'webhook' }
  excludedTargetIds: string[]
  linkOverrides: Record<string, string>
  lastPost?: { at: string; messageUrl: string; state: 'live' | 'ended' }
  lastError?: { code: 'webhook-deleted' | 'unreachable' | 'rejected'; at: string }
}
```

`messageUrl` = `https://discord.com/channels/{guildId}/{channelId}/{messageId}`.

Typed links (`linkOverrides`) must be absolute `https` URLs of at most 512
characters. Anything else is refused with a sentence, and the row's input
shows it.

**None of these methods may be added to the remote-control intent allowlist,
the Phone remote LAN router or `LAN_EVENTS`.**

### UI (the Discord section)

`components/streaming/discord-section.tsx`, rendered in `streaming-tab.tsx`
after the Stream details `PanelSection`. It uses the same `PanelSection`
primitive and is shadcn-only, following the videorc-design skill.

- **Header**: "Discord", described as "Tell your server when you go live."
- **No webhook yet**:
  - An `Input` ("Paste a Discord webhook URL") and a **Connect** button.
  - Helper: "In Discord: Server Settings → Integrations → Webhooks → New
    Webhook → Copy Webhook URL."
  - Inline errors:
    - "That isn't a Discord webhook URL."
    - "This webhook was deleted in Discord. Paste a new one."
    - "Couldn't reach Discord. Check your connection and try again."
- **Connected**, as dense rows in one `GroupedList`:
  1. **Webhook**: the webhook name, the masked hint, **Send test** and
     **Remove** (Remove confirms). An error state shows the `lastError`
     sentence and a **Replace** input.
  2. **Announce when I go live**: a `Switch`.
  3. **Post as**: a `Select` with avatar and name per option. The options
     are Automatic (it shows who that resolves to), each connected account,
     Videorc account, and Webhook's own name.
  4. **Ping**: a `Select` of No ping / @here / @everyone.
  5. **Links in the post**: one row per configured destination: a
     `Checkbox`, the platform icon and label, and the link.
     - Auto links appear muted, with an edit affordance to type an override.
     - "Link made at Go Live" appears for YouTube (signed in) and X.
     - Destinations without a link get an inline `Input`, and the checkbox
       stays disabled until a valid link is typed.
  6. **Show "Live with Videorc"**: a `Switch`.
- **Footer lines** (muted):
  - "Unlisted and private YouTube streams are never announced."
  - "Last post: today 18:02 · View in Discord", which opens the message URL
    externally.
  - While a session is active: "Changes apply to your next stream."
- **Toast** (sonner, neutral; the type colours the icon only): "Couldn't
  post to Discord: the webhook was deleted / Discord couldn't be reached /
  Discord refused the post", with an **Open** action that navigates to
  Livestream and scrolls to the Discord section.

The section lives in the lazily loaded Livestream tab chunk. Nothing goes in
the eager shell.

## Slices

### S1: Discord client, settings and secret (backend)

`gpt-5.5`. New `discord_announce.rs` (the client half) plus `mod`
registration.
- **Settings**: load and save `discord.announce`, with defaults `enabled:
  true` (on, once a webhook is saved), `ping: none`, `branding: true`,
  `postAs: automatic`, and empty exclusions and overrides.
- **Secret**: `discord.webhook.url` via `put_secret` / `try_get_secret` /
  `delete_secret`, plus a hint helper.
- **URL validation**:
  - Host `discord.com`, `discordapp.com`, `ptb.discord.com` or
    `canary.discord.com`, path `/api/webhooks/{digits}/{[A-Za-z0-9_-]+}`,
    with optional `/api/v10`.
  - Trim whitespace and strip query and fragment.
  - Apply the E8 debug-only fake allowance.
- **`verify_webhook`**: `GET`, mapping 404/401 to `webhook-not-found` and
  network errors to `unreachable`.
- **Pure payload builders**: `build_live_body`, `build_ended_body`,
  `build_test_body`, plus a username sanitizer, duration formatter and
  button rows.
- **Sender**:
  - `execute` uses `?wait=true&with_components=true`, as JSON or multipart
    with the thumbnail. `edit` uses PATCH with `with_components=true`.
  - It runs the D13/failure table, including the components fallback and
    `componentsRefused`.
  - Use reqwest (the existing client) with a 10 s timeout and the existing
    user-agent convention.
- **Tests** (local axum fake, like the `youtube.rs` tests):
  - URL validation table.
  - The verify mapping.
  - Golden JSON bodies for live, ended and test, with each ping value.
  - The components 400 fallback.
  - 429 `retry_after`.
  - Multipart with a thumbnail.
  - Username sanitizing.
  - A test that the webhook URL appears in no formatted error or `Debug`
    output (wrap it in a `Secret` newtype whose `Debug` redacts).
- Use `let _ = remove_dir_all(...)` in test cleanup (Windows trap).

**Done when** `cargo test -p videorc-backend discord_announce` passes and
`cargo clippy -p videorc-backend -- -D warnings` is clean for the module.

### S2: Trigger state machine and go-live hooks (backend)

`fable-5`.
- **`AnnounceSession`**: a pure state machine (E5) over `Fact`s
  (`SessionStarted`, `TargetsSnapshot`, `YouTubeLive{broadcast_id,
  privacy}`, `XPublished{account_id, share_url}`, `SessionEnded`, `Tick`)
  that returns `Action`s. It owns:
  - leg resolution (Excluded, NoLink, NotPublic, Pending);
  - the dwell (E2);
  - the first-confirmed post;
  - edit coalescing (E6);
  - the restart window (D14);
  - the ended edit;
  - the never-post-after-end rule.
- **Link builder**: one function, used by both the state machine and
  `discord.links.preview` (E10).
- **Post-as resolver**: Automatic picks the first ticked destination's
  account, then the Videorc account, then the webhook identity.
- **Announcer task**: owns the mpsc receiver plus an event-bus
  subscription. It turns `stream.targets` and `recording.status` into
  facts, runs actions through the S1 sender, persists `lastMessage`
  (refreshing `lastSeenLiveAt` every 60 s), and emits
  `discord.announce.changed` and the health events. Spawn it next to
  `usage_stats::spawn` (`main.rs:666`). Crash recovery runs after a 30 s
  delay at startup.
- **Hooks** (each a non-blocking `try_send`, E4):
  - `session.start` OK (`main.rs` near `spawn_session_live_chat`).
  - `streamTargets.youtube.transition` OK with `requested_status == Live`.
  - `streamTargets.x.publish` OK.
- **YouTube privacy**: parse `privacy_status` in `YouTubeBroadcastStatus`
  and carry it on `YouTubeBroadcastTransitionResult` (E3). The renderer type
  in `backend.ts` gains the optional field.
- **Unit tests** for `AnnounceSession` with a fake clock:
  1. The first ticked leg posts once; a second leg edits once, coalesced.
  2. A reconnect (Live → Reconnecting → Live) never re-posts.
  3. An unticked leg going live first does not trigger; a ticked leg later
     does.
  4. YouTube `unlisted` / `private` is skipped. If that leaves nothing,
     there is no post.
  5. Unknown privacy is skipped.
  6. A stop before any confirmation posts nothing.
  7. A stop during post retries cancels the post.
  8. A restart within 15 min edits the old message (no post); at 15 min
     plus 1 s it posts fresh.
  9. Crash recovery edits to ended with `lastSeenLiveAt`.
  10. A deleted message (PATCH 404) clears `lastMessage`.
  11. Feature off or no webhook means no actions.
  12. A recording-only session means no actions.
  13. X with `x_announce = false` still counts as public.

**Done when** `cargo test -p videorc-backend discord_announce youtube` passes
and a log grep in the tests shows no hook awaits network I/O. Review it: the
hook bodies are only `try_send`.

### S3: RPCs, contracts and secret-leak proof

`gpt-5.5`.
- The six RPCs and the event from **Wire shape**, with their
  `websocket_method_execution_policy` entries.
- `backend.ts` types (every optional field absent, never null, on the wire)
  and `backend-rpc-contract.ts` entries, plus the contract tests
  (`backend-rpc-contract.test.ts`, `protocol-contract-fixtures.test.ts`).
- Assert the methods are **absent** from the remote-control allowlist and
  the LAN router.
- Extend `smoke:streaming-secrets` (`scripts/smoke-streaming-secrets.mjs`)
  with a pasted webhook URL. Assert its token appears nowhere in:
  - the renderer-visible snapshots;
  - the backend log;
  - health events;
  - a generated support bundle.

**Done when** `pnpm typecheck`, `pnpm --filter @videorc/desktop test`, the
Rust RPC tests and `pnpm smoke:streaming-secrets` pass.

### S4: The Discord section (renderer)

`opus-4.8`. Load `.claude/skills/videorc-design/SKILL.md` and the shadcn skill
first.
- `components/streaming/discord-section.tsx` plus the hook
  `hooks/use-discord-announce.ts`. The hook gets the snapshot, subscribes to
  `discord.announce.changed`, and calls `discord.links.preview` whenever the
  destination list changes.
- Mount it in `streaming-tab.tsx` after Stream details.
- Every state from **UI**: empty, invalid, verifying, connected,
  error/replace, test sending/sent, the live-session note.
- The failure toast and its **Open** deep link (reuse the workspace
  navigation helper used by other "Open" toasts).
- Unit tests:
  - The URL format hint.
  - Rows: auto, at-go-live, none, typed.
  - The checkbox disabled without a link.
  - Exclusions round-trip.
  - The toast fires once per new `lastError`.
- Screenshot both themes (owner rule) in every state, using the dev app.

**Done when** the desktop unit tests and `pnpm lint` pass, and the screenshots
exist for light **and** dark in the empty, connected and error states.

### S5: `smoke:discord-announce`

`gpt-5.5`.
- `scripts/lib/fake-discord-webhook.mjs`: a local server recording every
  request (method, query, JSON or multipart, `allowed_mentions`). It
  supports scripted responses: 404, 429 with `retry_after`, a components
  400, 5xx.
- `scripts/smoke-discord-announce-app.mjs` drives the dev app with
  `VIDEORC_DISCORD_API_BASE_URL`, the fake YouTube API (from
  `smoke:youtube-quota`) and local RTMP sinks (from `smoke:multistream`).
  It asserts:
  1. Paste, then verify, shows the webhook name; **Send test** has
     `allowed_mentions.parse = []`.
  2. Go Live with a Custom destination (typed link) plus YouTube OAuth
     (public): exactly **one POST** with the streamer username and
     avatar, then **one PATCH** adding the YouTube button after the
     transition.
  3. A forced leg reconnect produces no new POST.
  4. Stop produces an ended PATCH ("Was live").
  5. Go Live again within the window produces a PATCH back to live and
     **zero POSTs**.
  6. An unlisted YouTube-only session produces zero requests.
  7. The fake returns 404 for the webhook: one failure toast, and no
     retries after the first.
  8. The webhook token never appears in the app log.
- Add `"smoke:discord-announce"` to `package.json`. Do **not** add it to
  `smoke:local-gates` unless it runs in under 90 s.

**Done when** `pnpm smoke:discord-announce` passes twice in a row on this
Mac.

### S6: Docs

`gpt-5.5`.
- `docs/discord-announce.md`: what it does, the trigger rules (E2, D7–D9,
  D14), the payloads, the failure table, the secret rules and the smoke.
- A short user-facing paragraph for the next changelog (held for the
  release; do not edit `changelog/` here).
- Update the plan 187 entry in `plans/README.md` (it already exists as PLANNED).

**Done when** the doc matches the built behaviour. Read it against S2's tests.

### S7: Gates, plus the real-Discord check (once, at the end)

1. Gates:
   - `cargo fmt --check --all`
   - `cargo clippy -p videorc-backend -- -D warnings`
   - targeted `cargo test -p videorc-backend discord_announce youtube x_live`
     (owner directive: no full Rust suite locally)
   - `pnpm typecheck && pnpm lint && pnpm format:check`
   - `pnpm --filter @videorc/desktop test`
   - `pnpm test:scripts`
   - `pnpm build` (renderer budget: the section must stay out of the eager
     chunk)
   - `pnpm smoke:streaming-secrets`
   - `pnpm smoke:discord-announce`
   - `pnpm smoke:youtube-quota`, because the transition parse changed.
2. **Real Discord check (owner provides a webhook in a private test server;
   never use a community server).**
   - Send test, then a real Go Live to a test destination (local RTMP or a
     Custom destination with a typed link), then Stop.
   - Confirm and screenshot:
     - (a) the link buttons render with `with_components=true`; if not, the
       fallback links render and `componentsRefused` is set;
     - (b) the sender name and avatar are the streamer's;
     - (c) the thumbnail survives the ended edit;
     - (d) @everyone pings on the live post and not on the test;
     - (e) the "View in Discord" link opens the message.
3. By-eye pass of the Discord section in both themes.

**Done when** all gates pass, the real check's screenshots are in the PR,
and "As built" is filled in.

## Out of scope

- Role pings, custom message templates and descriptions in the post.
- More than one webhook, and other services (Slack, Telegram, Bluesky,
  generic JSON webhooks).
- A per-destination switch on destination cards. The checklist is the one
  home.
- Buddy voice, chat commands, Stream Deck or Phone remote controls.
- Posting from videorc-web, or any server-side relay.
- Announcing recordings, clips or VOD uploads.
- Premium gating, or a "remove branding" upsell.

## STOP conditions

- The webhook URL or token shows up anywhere outside `secrets.rs`'s file:
  logs, events, snapshots, support bundles, panic messages, crash reports.
- Any hook would need to `await` on the go-live path, or `smoke:youtube-quota`
  / Go Live timing regresses.
- Discord rejects **both** the components post and the fallback for a
  user-created webhook.
- A new `Option` field is serialized as `null` on the wire. This is the
  serde null trap, which caused 3 app-load outages: use `skip_serializing_if`.
- YouTube privacy can't be determined for an OAuth leg in the real check
  (both the transition response and the draft are missing). Never "default to
  public".

## In-flight work on these files

- `use-studio.tsx` and `main.rs` are touched by almost every open PR. Keep
  the hooks to a few lines each and rebase late.
- The cloud version (desktop #727) is a draft that must never be merged and
  may touch go-live code. Do not build on it.

## Model lane note

The S2 state machine is the only subtle part. If S2's tests pass but the S5
smoke finds a double post or a missed post, re-run S2 on `fable-5` with the
failing smoke log, rather than patching in the smoke.

## As built

_Not started._
