# Unified Comments — Real Provider Smoke Checklist

Plan 033's provider checks are **manual, gated** smokes: they need live platform accounts
and real broadcasts, so they are not part of the account-free suite. The automated path is
`pnpm smoke:live-chat-fake-providers`, which drives the persisted coordinator, unified feed,
send-result honesty, highlight slot, and event protocol end to end over a real WebSocket.

## Automated (CI-able)

- [x] `pnpm smoke:oauth-guards` — PASS 2026-07-10; OAuth guard behavior and the
      non-blocking Google-approval warning are preserved.
- [x] `pnpm smoke:provider-readiness` — PASS 2026-07-10; reports YouTube paused
      and the isolated profile's missing Twitch/X live-account prerequisites without exposing secrets.
- [x] `pnpm smoke:live-chat-fake-providers` — PASS 2026-07-10; simultaneous
      YouTube/Twitch/X messages →
      deliberate timestamp disorder + duplicate deliveries → chronological live and SQLite
      snapshots → event-stream reconnect → correlated/idempotent send persistence. The result
      matrix must include sent, failed, receive-only, and timed-out-unknown without claiming an
      X account is connected. No OAuth required.
- [ ] `pnpm smoke:cohost-fake` — Live Co-host offline proof (no cloud, no account): launches
      the debug backend against an isolated profile and a local fake `POST /api/ai/cohost/tick`,
      scripts fake-connector lanes, and asserts the tick wire shape, one grouped question whose
      askers/messageIds grow across ticks, a flagged message, 429/403/503 → paused/paused/error
      with Retry-After and the backoff ladder honored, dismiss-never-returns, the 20 s trickle rule,
      `liveChat.send` + `inReplyToQuestionId` answering, and 30 s of idle chat without a tick.
      Askers are keyed on author + destination because the fake connector cannot script authors.

## Capture-performance regression

- [ ] Run `pnpm smoke:recording-performance` (and/or `pnpm smoke:preview-performance`) once
      with a fake live-chat session active (`liveChat.start` with a fake config) and confirm
      preview/recording metrics stay within their existing tolerances. Chat networking runs on
      isolated spawned async tasks that only touch provider status + the bounded buffer, never
      the capture/encode path, so there should be no regression.

## YouTube live chat (deferred until Google approval)

- [ ] Confirm YouTube chat readiness reports the Google approval pause message.
- [ ] Do not connect a YouTube OAuth account or run YouTube chat acceptance until Google approval completes.
- [ ] Use Manual RTMP for YouTube stream acceptance in the meantime.

## Twitch OAuth live smoke (requires a Twitch account with chat read + write scopes)

- [ ] Reconnect Twitch so the granted scopes include `user:read:chat` and `user:write:chat`;
      preflight must report read and write readiness separately.
- [ ] Go Live to Twitch; confirm the panel shows Twitch `connected` (EventSub welcome →
      subscriptions created).
- [ ] Post chat from another account incl. an emote + a cheer; confirm fragments + badges +
      the bits amount render, and duplicate EventSub deliveries are not double-shown.
- [ ] Send from Videorc and confirm Twitch receives it and the Twitch destination result reports
      `sent`; force a provider-side dropped response and confirm it reports the drop reason.
- [ ] Force a reconnect (toggle network); confirm the provider shows `reconnecting` then
      recovers, and `liveChat.diagnostics` reconnect count increments.

## X native comments

X delivers broadcast chat only through the X Activity API `broadcast.chat` event, pushed to the
videorc.com webhook; the backend long-polls that relay (`crates/videorc-backend/src/x_chat.rs`,
web side documented in `videorcweb/docs/x-chat.md`). Requires a signed-in Videorc account and
"Authorize X Live".

- [ ] Sign in to Videorc, authorize X Live, and start a native X broadcast so `broadcastId` is
      bound to the active stream target.
- [ ] Confirm X transitions from connecting to `X live chat connected.`, then post from a separate
      viewer account and verify the comment (name, avatar) appears within ~2 s in the same feed.
- [ ] Send from Videorc and confirm the message appears on X once and is not duplicated in the feed
      when X echoes it back.
- [ ] Toggle the network for ~20 s; confirm the provider shows `reconnecting`, recovers on its own,
      and no comment is duplicated or lost. A sustained outage records one `x-live-chat-failed`
      health event and keeps retrying.
- [ ] Sign out of Videorc and go live: X must show a failed state that says to sign in, never a
      silently empty feed. Manual-RTMP X targets have no chat by design.
- [ ] Disconnect X and confirm the `broadcast.chat` subscription is gone
      (`GET /2/activity/subscriptions`).

## Multistream + partial release

- [ ] Go Live to YouTube Manual RTMP + Twitch + X simultaneously; confirm a single unified panel shows
      every platform's state and merges Twitch + native X comments chronologically, while
      YouTube reports the Google approval pause without blocking Go Live.
- [ ] Send one message from Videorc. Every writable destination receives one copy and reports
      its own result; X remains explicitly receive-only rather than being omitted or shown sent.
- [ ] Confirm the streamer can read all comments from the in-app panel **without opening any
      platform dashboard**.
- [ ] Click a live comment and confirm `On stream` appears only after the card is visible on the
      viewer-facing output; historical comments must not expose the highlight action.

## Live co-host (Premium, opt-in)

Prerequisites: Premium account signed in, AI consent ON, Settings → Streaming → Co-host enabled,
web has `VIDEORC_AI_COHOST_DISABLED` off. Offline proof: `pnpm smoke:cohost-fake`.

- [ ] Go Live with Twitch + YouTube chat attached. Confirm the Co-host chip reads
      `listening` only after `cohost.start` succeeded; with consent OFF it must read
      `paused · consent` and no tick request leaves the machine.
- [ ] Have viewers ask the same question three times in different words. Confirm ONE grouped
      question appears with all askers and platforms, and a `suggestedReply` in English
      (the server pins question summaries and replies to English until a language setting
      exists — ask one of the three in another language and confirm the draft is still
      English); confirm no tick fires while chat is idle for 30 s.
- [ ] Press `R` on the question, edit the draft, send with ⌘↩. Confirm one message per
      writable destination (X stays receive-only) and the question leaves the list on its own
      (`answered` via `inReplyToQuestionId`) — never by auto-send.
- [ ] Press `H` on a question: the source comment appears on the viewer-facing output for ~10 s
      via the existing comment highlight; `A` and `⌫` remove questions and they never return.
- [ ] Post a clearly toxic message from a viewer account. Confirm it shows under Flags with a
      reason and that nothing is auto-deleted or auto-replied.
- [ ] Sign out mid-stream: chip reads `paused · signed out`; sign back in and confirm listening
      resumes without losing open questions. Exhaust the daily quota (or set the limit to 1 on
      web): chip reads `quota` and resumes after `Retry-After`.
- [ ] Verify in the web ops dashboard that `ai_usage_events` gained one `cohost-tick` row per
      tick with model + tokens.
