# 2026-09-24 Stream Manager acceptance (plan 053, with plan 054)

The Stream Manager replaces the Chat window: the whole chat, live viewers,
followers, supporters, tips, an activity feed and stream health across every
destination. Branch `feat/stream-manager`, based on `a3ababf9` (0.9.103).

## Local gates (macOS, 2026-09-24)

| Gate                                                                                                                                                                          | Result                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`                                                                                                                                                              | PASS                                                                                                                                                               |
| `pnpm lint` (ESLint + em-dash gate)                                                                                                                                           | PASS                                                                                                                                                               |
| `pnpm format:check`                                                                                                                                                           | PASS                                                                                                                                                               |
| `pnpm --filter @videorc/desktop test`                                                                                                                                         | PASS (2,056 tests)                                                                                                                                                 |
| `pnpm test:scripts`                                                                                                                                                           | PASS (1,460 tests)                                                                                                                                                 |
| `cargo fmt --check --all`                                                                                                                                                     | PASS                                                                                                                                                               |
| `cargo clippy -p videorc-backend -- -D warnings`                                                                                                                              | PASS                                                                                                                                                               |
| Targeted `cargo test -p videorc-backend` (live_chat, twitch_chat, youtube_chat, x_live, viewer_stats, audience, session_token, storage, remote_lan, oauth, protocol fixtures) | PASS                                                                                                                                                               |
| `cargo check --release -p videorc-backend`                                                                                                                                    | PASS (no warnings in changed files)                                                                                                                                |
| `pnpm build`                                                                                                                                                                  | PASS                                                                                                                                                               |
| `pnpm check:renderer-assets`                                                                                                                                                  | Local red by the known macOS gzip drift (386,002 local; about 384,400 on CI's Linux gzip, budget 385,000); raw 1,993,898 under 2,000,000. CI is the enforced gate. |
| `pnpm probe:comments-window`                                                                                                                                                  | PASS, including the 320/480/640/800/1040/1280 width sweep                                                                                                          |
| `pnpm smoke:live-chat-fake-providers`                                                                                                                                         | PASS, extended: 7 activity kinds with details persisted, audience baseline and delta                                                                               |
| `pnpm smoke:cohost-fake`                                                                                                                                                      | PASS                                                                                                                                                               |
| `pnpm smoke:comment-highlight-stream`                                                                                                                                         | PASS (stream-only, split, legacy 60 fps)                                                                                                                           |
| `pnpm probe:ui-glass --gate`                                                                                                                                                  | PASS on rerun (first run: Notes window open timing under load; Stream Manager pinned dark in both themes)                                                          |
| `pnpm smoke:remote-lan`                                                                                                                                                       | PASS (phone chat projection unchanged)                                                                                                                             |

## What the gates prove

- One viewer total across samplers, never a partial one (B1), and a saved
  history that reads back (`sessions.viewers.list`).
- X viewer counts parse the documented `data` envelope (plan 054). A poll
  without a count logs its reason once (`stream-viewers-x`).
- Structured details for subs, gifts, cheers, raids, announcements, Super
  Chats, Stickers and memberships survive delivery, persistence and the
  renderer. Plain rows carry none of the new keys.
- First-time chatters are marked once, and returning chatters never are.
- Followers and subscribers per platform, with a baseline and "+N this
  stream". A refused token asks for a reconnect; a hidden count says so.
- Tokens that expire mid-stream are renewed. A revoked refresh token fails
  the provider row clearly instead of going quiet (B2).
- Twitch follow alerts and the sub total, behind an opt-in reconnect.
- The dashboard relay is main-only for writes: the probe's forged push is
  refused.
- The window at every width: no overflow, the viewer count visible while
  live, no buttons in the title row, and every control reachable.

## Owner live acceptance (pending)

Run one real stream to Twitch and X (and YouTube in a verification build)
with the Stream Manager open. Then:

- [ ] Viewers match each platform's own dashboard within one sampling
      period (30 s). **X shows a count within 60 s, and the tooltip lists
      X** (plan 054 S3). Record the `stream-viewers` sample line here. If X
      is missing, attach the `stream-viewers-x` log line.
- [ ] Followers match each platform, and "+N this stream" moves after a
      test follow.
- [ ] Livestream → Setup → Twitch → **Reconnect Twitch** grants follow
      alerts and the sub count. A test follow appears in Activity; the
      Supporters tile shows the sub total.
- [ ] Activity matches Twitch's own Activity Feed for subs, gifts, cheers
      and raids. A community gift of N reads once.
- [ ] Show on stream from an Activity row puts the event card on the
      stream.
- [ ] Chat under load: a busy chat stays smooth. The paused chip appears
      when scrolled up and "Chat paused, N new" jumps back.
- [ ] "Send to" reaches only the picked platforms. With X picked, the
      draft caps at 140.
- [ ] A stream longer than 4 hours keeps Twitch chat and viewer counts
      (token refresh).
- [ ] Settings → "Open Stream Manager when I go live" opens it on Go Live.
- [ ] By eye at 320, 800 and 1,280 px, plus Windows (solid dark).

## Changelog draft (next release)

**Stream Manager: your whole stream in one window.** The Chat window is now
the Stream Manager:

- Live viewers with the peak and a sparkline.
- Followers, with how many you gained this stream.
- Subs and gifts, tips, chat pace and stream health.
- An Activity feed for follows, subs, gifts, cheers, Super Chats, raids and
  destination outages. Show any of them on stream or thank them in chat.
- Chat with emotes, first-time chatters, replies, filters and search, and
  a "Send to" picker.

It fits any width, from a narrow sidebar to a full screen.

**X viewer counts show up.** The watching count and its tooltip now include
X alongside YouTube and Twitch.

**Follow alerts and your Twitch sub count** are one reconnect away:
Livestream → Setup → Twitch.

Windows Alpha carries the same Stream Manager; its window stays solid dark.
