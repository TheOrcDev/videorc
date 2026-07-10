# Unified livestream comments — acceptance (2026-07-10)

## Outcome

**Overall status: BLOCKED.** Milestone A's implementation and focused
account-free acceptance are complete. The aggregate local-gates command is
blocked by a pre-existing, out-of-scope Plan 027 smoke import; its remaining
constituent gates pass. The real-provider rows remain blocked on owner-supplied
Google approval and live provider/viewer accounts. The full recording-studio
gate also reached its real ScreenCaptureKit device step without a native source
being exposed to this isolated worktree process. Milestone B remains blocked
because Videorc has no documented, approved X native livestream-chat write
contract.

This is not a partial-success euphemism: the shipped product boundary is one
authoritative YouTube/Twitch/X feed, send-to-every-writable-destination with an
explicit X receive-only result, and backend-acknowledged viewer-facing comment
highlights. It does not claim that an X Post is live chat or that unavailable
real accounts were tested.

## Implemented contract

- The backend owns destination-scoped read/write truth keyed by target id,
  normalized message identity, provider deletion tombstones, and persisted
  chronological snapshots.
- One durable, idempotent send operation fans out concurrently. Every active
  destination reaches a terminal `sent`, `failed`, `read-only`, `unavailable`,
  or `timed-out-unknown` result; ambiguous sends are never retried
  automatically and no optimistic fake comment is inserted. A write-ready
  Twitch sender remains usable while its independent EventSub reader
  reconnects.
- The backend owns highlight eligibility, install acknowledgement, generation,
  ten-second expiry, session cleanup, and output-path capability. The UI shows
  `On stream` only after the viewer-facing overlay is live.
- The main-process Comments broker correlates detached-window commands,
  validates sender/session/mode, and keeps live and history caches separate.
  History has no composer or highlight action.
- Each WebSocket has a bounded outbound event queue. Slow clients backpressure
  the broadcast receiver, receive `events.lagged`, and reconcile from a fresh
  authoritative snapshot instead of accumulating an unbounded backlog.
- Both Comments surfaces share the same row behavior and destination status
  language. X is visible as receive-only instead of being omitted.

## Automated evidence

| Gate | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | PASS |
| `pnpm --filter @videorc/desktop test` | PASS — 66 files, 558 tests |
| `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings` | PASS |
| Full Rust tests | PASS — native helper 42/42; backend 883 passed, 7 ignored; wire 1/1 |
| `pnpm test:scripts` | PASS — 384 tests |
| `pnpm audit:js`, `pnpm audit:rust` | PASS at repository policy thresholds |
| `pnpm smoke:oauth-guards` | PASS — pre-approval YouTube stays explicitly unavailable |
| `pnpm smoke:live-chat-fake-providers` | PASS — 375 simultaneous messages, 4 duplicate deliveries removed, deliberate timestamp disorder reconciled, reconnect observed, and every send-result class proven |
| `pnpm probe:comments-window` | PASS — real detached-window IPC for send, applying/live/failed highlight, live/history isolation, and history without actions |
| `pnpm smoke:comment-highlight-stream` | PASS — full card plus captions proven in stream-only and split record+stream artifacts; legacy greater-than-30-fps output returns typed `highlight-unavailable` |
| `pnpm smoke:recording-studio` | BLOCKED at step 19 — steps 1–18 passed, including all-layout artifact inspection, imported-screen recording, native CAMetal preview/lifecycle probes, and the integrated highlight artifact; the isolated backend exposed no ScreenCaptureKit source for the real-device step |
| `pnpm smoke:local-gates` | BLOCKED after build, Rust, clippy, OAuth, and OAuth-guard passes by the pre-existing out-of-scope `smoke:sources` import of removed `sourceSelectionChangeMessages`; Plan 033's remaining constituent gates were run directly |

The fake-provider smoke persists coordinator state to SQLite, compares the live
and stored chronological snapshots, reconnects the event stream, and rehydrates
the same send operation after reconnect. Its destination matrix includes
provider-confirmed sent, failed, receive-only, and timed-out-unknown outcomes.

The integrated highlight smoke clicks a row through the actual detached
Comments window, waits for backend `live`, then inspects finished video frames.
The latest retained evidence from the recording-studio run is:

- `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-comment-highlight-stream-1783644267511`

## Visual acceptance

The named captures passed by-eye review for hierarchy, clipping, state clarity,
and live/history distinction:

- detached Comments window, 420×640:
  `/var/folders/5b/08_snhzs2xb559qf1j6dth2r0000gn/T/videorc-comments-window-probe-1783645905331/`
  (`idle`, `live`, `highlight-applying`, `highlight-failed`,
  `partial-send-x-receive-only`, and `history-no-composer`);
- Studio Comments rail, dark: `/tmp/videorc-ui-comments-rail-dark.png`;
- Studio Comments rail, light: `/tmp/videorc-ui-comments-rail-light.png`.

At 420 px the destination results remain legible, the selected/applying/live/
failed states are distinct, partial delivery keeps YouTube/Twitch/X visible,
and history has neither a composer nor an actionable comment row.

## Real-provider and device acceptance

These rows were not inferred from fakes. Each missing prerequisite is recorded
as a scoped blocker with an owner.

| Capability | Status | Owner | Evidence / unblock |
| --- | --- | --- | --- |
| YouTube read + write | BLOCKED | Videorc owner | Production OAuth remains paused pending Google approval. The release-safe OAuth/client configuration and a separate viewer account are required before live proof. |
| Twitch read + write | BLOCKED | Videorc owner | Automated EventSub/read/send/drop/reconnect contracts pass; a live broadcaster plus separate viewer account was not provided to this isolated run. |
| X native read + reconnect | BLOCKED | Videorc owner | Automated token/access/WebSocket/read/reconnect contracts pass; a real approved X account, broadcast, and separate viewer account were not provided. |
| X native write | BLOCKED | Videorc owner / X partner | No documented, approved Videorc native livestream-chat write contract exists. The UI therefore reports receive-only and never substitutes an X Post. |
| Real-player highlight parity | BLOCKED | Videorc owner | Deterministic output artifacts pass, but one real comment from each provider still needs confirmation on the outgoing players using separate viewers. |
| Real ScreenCaptureKit recording step | BLOCKED | Local operator | Grant/expose the native screen source to the isolated worktree backend, then rerun recording-studio steps 19–20. The maintained native CAMetal preview, lifecycle, placement, and reattach probes already passed. |

Owner sign-off: **pending**. No real-provider acceptance row is marked complete.

## Provider deletion contract check

The implementation follows the current provider contracts checked on
2026-07-10:

- Twitch `channel.chat.message_delete` identifies the deleted message with
  `event.message_id`:
  <https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage_delete>.
- YouTube's current API represents removed messages as `tombstone` resources;
  the June 23, 2026 revision records the deletion-event removal, while Videorc
  retains defensive parsing for the deprecated shape:
  <https://developers.google.com/youtube/v3/revision_history#june_23_2026> and
  <https://developers.google.com/youtube/v3/live/docs/liveChatMessages>.

Deleting a provider message tombstones the original row, wins even if it
arrives before the original delivery, and clears a matching on-stream
highlight.
