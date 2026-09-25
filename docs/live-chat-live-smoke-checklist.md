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
- [ ] `pnpm smoke:cohost-fake` — Orcle offline proof (no cloud, no account): launches
      the debug backend against an isolated profile and a local fake `POST /api/ai/cohost/tick`,
      scripts fake-connector lanes, and asserts the tick wire shape, one grouped question whose
      askers/messageIds grow across ticks, a flagged message, 429/403/503 → paused/paused/error
      with Retry-After and the backoff ladder honored, dismiss-never-returns, the 20 s trickle rule,
      `liveChat.send` + `inReplyToQuestionId` answering, and 30 s of idle chat without a tick.
      Askers are keyed on author + destination because the fake connector cannot script authors.
      A second scenario (plan 060) runs a headless stream session (test pattern into a local
      `ffmpeg -listen` RTMP sink) and live captions through the fake caption service behind the
      same API origin (scripted realtime finals; the debug caption-contract audio seam stands in
      for a microphone). It asserts: a final that mentions a comment puts it in `spotlight`
      within 4 s; every `POST /api/ai/cohost/spotlight` body has consent, at most 20 candidates,
      a transcript of at most 800 chars and never the flagged message; in "What I talk about"
      mode the engine emits `autoHighlight {source: voice}` and the card goes live with
      always-set semantics (the smoke plays the renderer's executor), refreshes at most once and
      leaves by expiry, never a clear; a question enters `recentlyResolved` only on the second
      "answered" hit and `cohost.question.restore` puts it back; a queued 404 closes the lane
      (no spotlight request for 6 s) without touching the tick status; in "What I talk about and
      Orcle's picks" mode no card fires for 45 s after the previous card left the stream, then
      the first pick is never the flagged message (which the fake suggests first on purpose),
      the one already shown, or the previous card's author. Whole run: about 4 minutes.

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

## Orcle (Premium, opt-in)

Prerequisites: Premium account signed in, AI consent ON, Settings → Streaming → Orcle enabled,
web has `VIDEORC_AI_COHOST_DISABLED` off. Offline proof: `pnpm smoke:cohost-fake`.

- [ ] Go Live with Twitch + YouTube chat attached. Confirm the Orcle chip reads
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

### Show on stream automatically (plan 060)

Prerequisites: live captions ON with a working microphone (the "What I talk about" modes read the
caption transcript), a real stream going out, and at least one viewer account that can post.

- [ ] Settings → Streaming → Orcle → "Show on stream automatically" offers exactly Off, What I
      talk about, and What I talk about and Orcle's picks, with the helper line "What I talk
      about needs live captions." The row is disabled without Premium like the rest of Orcle.
- [ ] Off: chat, questions and highlights keep working and nothing ever goes on stream by itself.
- [ ] What I talk about: have a viewer post a comment, then talk about it in your own words
      (do not read it out). Within a few seconds the comment row shows the quiet "Talking about
      this" mark, the Comments window scrolls it into view (unless you scrolled up in the last
      5 s), the matching question row carries the same mark, and the card appears on the
      viewer-facing output. Close the Comments window and confirm the pull-up still shows in
      the Stream Manager.
- [ ] While the card is up, keep talking about the same comment: it stays up (one refresh at
      most) and is never taken down and put back. Press `H` on another comment: your manual card
      wins and the automatic one never replaces it.
- [ ] Answer an open question out loud, twice in a row. After the second answer it leaves the
      open list and shows as one collapsed "Answered on air: <text>" line with Restore. Press
      Restore: the question returns to the open list and the line disappears. Without Restore
      the line is gone after 60 s.
- [ ] What I talk about and Orcle's picks: after a card leaves the stream, nothing new goes on
      stream by itself for 45 s (time it); after that Orcle may put one of its picks up, never
      the author of the previous automatic card and never a comment already shown.
- [ ] Post a flagged (toxic or spammy) message and then talk about it on air: it gets no
      "Talking about this" mark and never appears on stream in any mode, even if it was suggested.
- [ ] Turn captions off mid-stream: the pull-up stops, nothing errors or toasts, and picks mode
      keeps working without captions.
