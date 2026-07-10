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

## X native comments (receive-only)

- [ ] Use an account approved for Videorc's private X Livestream API and start a native X
      broadcast so `broadcastId` and `mediaKey` are bound to the active stream target.
- [ ] Confirm X transitions from waiting/connecting to readable, then post from a separate
      viewer account and verify the comment appears in chronological order in the same feed.
- [ ] Interrupt the X chat socket and confirm bounded reconnect returns to readable without
      duplicating replayed messages.
- [ ] Confirm X is visibly `receive-only` in the composer destination results. Do not claim or
      test native X chat sending until X supplies a documented, approved write contract.

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
