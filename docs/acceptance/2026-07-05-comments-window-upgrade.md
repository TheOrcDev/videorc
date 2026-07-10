# Comments window upgrade — acceptance (2026-07-05)

Multi-platform comment identity, click-to-highlight on the stream, and
send-to-all — slices S1–S6. Plan: vault
`plans/planned/2026-07-05 - Videorc Comments Window Upgrade Plan.md`.
Commits: `1296ab04` (S1 glyphs+avatars) → `7743622a` (S2 highlight slot) →
`bfa5fead` (S3 click-to-highlight) → `01ac089a` (S4 send fan-out) →
`184d8177` (S5 send input) → S6 (this record + smoke extensions).

## What shipped

- **S1** — every chat row (Comments window + Studio rail) shows the platform's
  brand glyph and the author's avatar. Avatars are cached by main from
  allowlisted platform CDNs and served via `videorc-asset://avatar/...`
  (monogram fallback); Twitch avatars backfill via one Helix lookup per
  chatter (read scope, session-cached).
- **S2** — the compositor gains a DEDICATED highlight overlay slot
  (`comments.highlight.set/clear`), independent from the captions bar:
  highlight top, captions bottom, coexistence pixel-tested; cleared at
  `start_session`; burns on the stream leg per the leg-plan matrix
  (record-only sessions never burn it).
- **S3** — clicking a comment (window or rail) renders a glass card (avatar,
  name, up to 3 text lines) at stream width and installs it in the slot.
  Same-click un-pins, another click replaces, 10s auto-dismiss, session end
  clears; stale timers can't kill newer highlights (pure reducer, tested).
  Both surfaces mark the row "On stream".
- **S4** — `liveChat.send` fans one message to every connected platform with
  send credentials (session-scoped, dropped at stop). YouTube via
  `liveChatMessages.insert` (existing scope suffices); Twitch via Helix with
  the NEW `user:write:chat` scope — pre-existing connections classify sends
  as reconnect-required with plain-words guidance. Per-platform results;
  partial success is never silent.
- **S5** — the Comments window's send row: Enter to send, chips showing the
  exact destinations, optimistic "You" echo in the feed, inline per-platform
  failure lines; X/custom honestly report unsupported.

## Automated results (2026-07-05)

| Gate                                                                                                                                                               | Result                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `pnpm --filter @videorc/desktop test` (407 tests; new avatar-cache, chat-avatar, comment-highlight, chat-send suites)                                              | PASS                                    |
| `cargo test -p videorc-backend` (709; leg-plan matrix, overlay coexistence, sender registry session-scoping, Helix avatar parsing, send-body shape) + fmt + clippy | PASS                                    |
| `pnpm typecheck`, `pnpm lint`, prettier per slice                                                                                                                  | PASS                                    |
| `scripts/smoke-live-chat-fake-providers.mjs` extended: send fan-out honesty (no sender ⇒ never "sent"; empty message rejected) + highlight set/clear round-trip    | PASS                                    |
| `pnpm smoke:recording-studio` (compositor touched)                                                                                                                 | run at close — see release/commit notes |

## Owner by-eye checklist (pending — needs a real YouTube+Twitch live session)

1. Go live to YouTube + Twitch simultaneously; open the Comments window:
   merged feed with correct platform glyphs; YouTube avatars immediately,
   Twitch avatars appear after each chatter's first message.
2. Click a comment → it appears ON the stream (check both platforms' players)
   as the glass card with avatar/name/text; captions (if on) stay at the
   bottom simultaneously.
3. Click the same comment → card leaves; click another → replaces; wait 10s →
   auto-dismisses; row shows/loses "On stream" in both window and rail.
4. Type in the send row → message lands in BOTH platform chats; the "You"
   echo appears immediately; platform copies arrive as confirmation.
5. On a Twitch connection made before this release: send → inline
   "reconnect to grant the new chat permission" line; reconnect Twitch →
   send works.
6. Stop the session mid-highlight → the card leaves the stream; start a new
   session → no inherited highlight.

Sign-off: _pending owner pass_

## Superseded behavior and hardening (2026-07-10)

Plan 033 replaces several optimistic S3-S5 behaviors above. The historical
record remains useful, but the current contract is now:

- the backend owns highlight acknowledgement, eligibility, the ten-second
  lifetime, session teardown, and deletion teardown; a renderer cannot claim
  `On stream` from local state;
- a send is one durable, idempotent operation with one terminal result per
  concrete destination, including provider message IDs, failures,
  receive-only destinations, and `timed-out-unknown` without automatic retry;
- the optimistic `You` echo is removed because it could claim delivery before
  either provider accepted the message;
- X native live chat remains explicitly receive-only until X supplies a
  documented, approved write contract; an X Post is not substituted for live
  chat;
- provider deletion events tombstone the original row and remove a matching
  active highlight. Twitch uses the current `event.message_id` contract;
  YouTube handles current `tombstone` rows and the deprecated deletion-event
  shape defensively.

Current implementation, artifact evidence, and scoped external blockers are
recorded in `docs/acceptance/2026-07-10-unified-livestream-comments.md`.
