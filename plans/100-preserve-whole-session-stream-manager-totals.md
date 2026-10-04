# Plan 100: Preserve whole-session support and chat totals beyond the visible buffer

> Implemented with focused verification; final app and broad gates pending. Drift check: `git diff --stat 05ff9188..HEAD -- crates/videorc-backend/src/storage.rs crates/videorc-backend/src/live_chat.rs crates/videorc-backend/src/live_chat_persistence.rs apps/desktop/src/shared apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/lib/stream-manager-stats.ts apps/desktop/src/renderer/src/lib/stream-activity.ts apps/desktop/src/renderer/src/components/stream-manager/stream-manager.tsx`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

## Status

- Priority: P1
- Effort: M–L; durable reduced accounting and an explicit historical coverage boundary
- Risk: MED; preserve existing rows and dedupe while making accounting transactional
- Depends on: none; independent of Plan 099
- Category: bug
- Planned at: `05ff9188`, 2026-10-03, release 0.9.129
- Confidence: HIGH, source-confirmed bounded-buffer accounting error
- Implementation: `bd85a1ef947fd321f192f7c98fa2556e6f0bbf84`, [PR 557](https://github.com/TheOrcDev/videorc/pull/557), merged to main as `5bdcd882ee697820daf913383f08f76acc9d879a`
- Acceptance: independent focused checks pass; full suites, build and app/E2E remain deferred until all fixes land

## Problem and reproduction

Stream Manager labels support/tip metrics “this stream” but sums the retained chat messages. A Twitch subscription and a $20 YouTube Super Chat at stream start can disappear from those totals after 2,000 ordinary messages evict them. Unique-chatters totals have the same window limitation. This misrepresents the stream's history without a reversal or session change.

Use fake providers and one session: deliver one sub, one Super Chat, then over 2,000 distinct ordinary messages. Observe that the live list remains bounded while totals must remain unchanged. Close/reopen Stream Manager and select the session in History; totals must agree.

## Current state

- `components/stream-manager/stream-manager.tsx:273,420` supplies capped `snapshot.messages` to `statItems`.
- `lib/stream-manager-stats.ts:508` uses `activityTotals(input.messages)`; lines 418 and 443 label output as session support/tips.
- `lib/stream-activity.ts:416` iterates only those rows to sum supporters, bits, tips and raids, with community-gift dedupe.
- `lib/live-chat-view.ts:18,259` caps rendering at 2,000.
- `crates/videorc-backend/src/live_chat.rs::try_deliver_messages` around 2965–3067 persists under the delivery fence before emitting messages.
- `storage.rs::save_live_chat_messages` around 2789 uses transactions, ID conflict handling and persisted `details_json`; its recent-row reader caps at 5,000 and is also unsuitable as a whole-session aggregate.
- `apps/desktop/src/shared/backend.ts::CommentsHistoryStats`, `shared/live-dashboard.ts`, and `main/index.ts::loadCommentsHistoryStats` carry the current history/dashboard stats. History rows are capped too.
- Match `stream-activity.test.ts` gift dedupe and totals cases, `stream-manager-stats.test.ts` subs/tips/history cases, and storage's message details roundtrip/page tests.

## Scope

In scope: durable whole-session aggregation in `storage.rs` and delivery ownership in `live_chat.rs`/`live_chat_persistence.rs`; additive shared Rust/TS mirrors as needed; shared history/dashboard types; main history projection; renderer stats model and tests. Update the live/history call sites to use confirmed aggregates.

Out of scope: provider billing, follower/viewer polling, Activity list retention, chat cap/virtualization, currency conversion, and display redesign. Do not materialize all chat rows in the renderer or remove caps.

## Execution preparation

The historical Chat count also uses `input.messages.length` in `stream-manager-stats.ts::chatItem`; restore a confirmed whole-session row count alongside unique chatters, with explicit message/deletion semantics. Platform eligibility and support labels currently derive from retained rows/provider snapshots. A paid event from an evicted platform must remain displayable in reopened/History stats, so characterize that case rather than only same-platform rollover. Existing gift rules collect community-parent IDs even when the parent is tombstoned, then suppress matching child contributions; preserve or explicitly document/test any changed correction policy. Do not introduce unbounded Rust identity sets or a full-session scan for every individual delivery. Use bounded database aggregation or transactional contributions and show delivery/persistence ownership plus reopen consistency.

Persistence ownership characterization is required too: `LiveChatMessage.id` is documented as `{platform}:{providerMessageId}`, while SQLite uses `id` as the global primary key. Its existing conflict update changes details/deletion/content but does not change `session_id`, `platform` or `provider_message_id`. Test a reused ID across two persisted sessions and define the aggregate/delivery result explicitly; do not silently attribute a correction to the newer session or mutate the earlier session's confirmed aggregate. If this needs a historical identity migration/backfill, honor the STOP boundary and specify that policy before proceeding.

Production tombstone ownership matters for gift corrections: `LiveChatCoordinator::ingest_reversible` preserves the original author and chronological fields, clears fragments/amount text, and replaces the row with the incoming tombstone; it does not copy original `details`. Persistence can therefore overwrite original gift metadata with a tombstone's absent details. Characterize parent deletion through actual ingest/persistence, not only pure fixtures whose deleted parent retains gift details. Determine what existing persisted data can prove before choosing the parent/child policy; if historical overlap cannot be recovered, honor the existing STOP boundary and specify a conservative historical/backfill policy rather than inventing missing metadata or claiming exact unsupported totals.

Current producer identity is stronger than the older Rust field comment: `live_chat_message_id` already includes session, platform and destination before the provider ID. Preserve canonical producer IDs and correct stale documentation if touched. The reused-ID regression exercises the storage ownership invariant; it does not justify migrating valid production IDs. Local chat clear resets the visible/unread journal while retaining persisted session rows. Confirmed whole-session totals must therefore survive clear/reopen and duplicate redelivery, with a reset only for a different session or an explicit persisted correction/deletion policy.

## Approved execution policy at the historical STOP boundary

Actual source cannot reconstruct erased gift-parent metadata or lost second-session rows from a past global-ID collision. Root approved a conservative coverage boundary before production edits: preserve all existing rows and histories, mark pre-ledger sessions unavailable for exact whole-session totals, and do not fall back to capped numbers labelled “this stream.” Plain product copy must explain unavailable totals without exposing database implementation details. New sessions have durable complete coverage, including a zero-event initial state, local clear, duplicate redelivery, reopen and final History.

Retain the existing global primary key and canonical producer IDs. Enforce recorded session/platform/destination/provider ownership on conflict, failing the entire transaction closed for a different owner. Prove the earlier row/aggregate remains unchanged and the rejected delivery rolls back/refuses. A composite-key table rebuild is not approved: accepting a caller-reused invalid ID does not justify a potentially large history rewrite. No missing historical facts or rows are invented.

Maintain transactional reduced per-row contributions and indexed parent/group/chatter bookkeeping, without deleted text, fragments or paid detail payloads. Corrections replace active contributions. Count each persisted row once, including a tombstone, but exclude deleted rows from unique chatters and support/tip contributions. A known community parent suppresses grouped children even if the parent is deleted, matching the existing rule. Update only old/new and affected indexed contributions; no full-session scan per individual delivery or unbounded Rust identity sets. New schema initialization must not scan/rewrite existing histories; stop and present a revised design if that boundary cannot be preserved.

Model RED reproduced the rollover: 15 cases passed and one failed because supporters fell from expected one to zero after 2,001 ordinary rows (`/tmp/videorc-fix100-exec-model-red.log`). Actual ingest/persistence deletion characterization passed: the stored deleted parent has no details while its grouped child retains its contribution (`/tmp/videorc-fix100-exec-tombstone-characterization.log`). The reused-global-ID regression failed as expected: session 2 overwrote session 1's 100-bit contribution with 900 bits and stored no row for session 2 (`/tmp/videorc-fix100-exec-identity-red.log`). The independent gift model agrees that erased metadata cannot prove suppression. Approval covers the concrete scoped policy above; implementation and focused verification remain in progress.

The independent transport boundary is approved: a bounded, strictly validated session/revision-scoped `liveChat.totals` event and typed `sessions.comments.totals` hydration RPC feed dashboard/history only. Keep chat snapshot/admission journals unchanged. Current confirmed session and monotonic revision own live updates and hydration; delayed/stale replies cannot restore another session or lower a newer total. Include zero-event state, event-before-status, cached seed, reconnect/reopen, terminal History and clear. Preserve renderer/admin permissions; no LAN event/router expansion or remote history access. Update all affected Rust/TypeScript/RPC/IPC/dashboard mirrors and shared contract fixtures.

## Authoritative persistence outcome contract

Early implementation review found that skipping an undeleted replay of a persisted tombstone in SQLite could still return success while publishing the original undeleted live/cohost row. The approved repair returns only the bounded input batch's persisted outcomes through the existing worker acknowledgement. Reconcile exact ID/session/owner association under current delivery/highlight ownership before publication. Compact per-row undo/replay must also preserve unread/received/trimmed counters; do not clone the coordinator's whole transcript. Add actual delivery tests for clear/eviction replay, batch failure rollback and stale generation. This is part of the totals/persistence fix, not a change to renderer admission journals. Genuinely new fake sessions need complete zero-event coverage; existing fake histories remain legacy unavailable.

Relay review also requires a confirmed session fence independent of dashboard fields that viewer/audience/health events can replace. Test confirmed B followed by delayed A events/totals, pending same-session revision ordering, and stale cache/hydration. Accounting parity review found that an empty gift-group ID is ungrouped in the existing JavaScript model; treat it as absent in the reduced ledger and cover empty-ID parent/child behavior.

Ownership refusal must also cover an ID still retained in the current coordinator. Its duplicate fast path otherwise discards an altered platform/destination/provider identity before SQLite can reject it. Characterize a conflicting retained ID after a fresh batch prefix through actual delivery; refuse the whole batch and restore rows, counters and totals without publication. Preserve normal duplicate suppression and bounded buffer ownership checks; do not persist every duplicate or introduce a lifetime identity set merely to reach the storage guard. Keep RPC and accounting identifier/currency bounds identical in Rust and TypeScript, including multibyte input.

The actual retained-owner regression failed as expected before the guard: the platform-conflicting duplicate was accepted after its fresh prefix (`/tmp/videorc-fix100-exec-retained-identity-red.log`). This confirms the fast-path bypass rather than an inferred database-only risk. The bounded retained-owner guard now rejects the entire batch and restores exact authoritative rows, counters and totals without publication; independent actual-delivery tests pass.

Zero-valued active Super Chats/Stickers retain their currency in the existing activity model. Preserve that accounting rule with indexed active-currency references alongside the reduced contributions; remove a currency only when its last active contribution is deleted or corrected away. This narrow additive table is approved under the same transaction, wire bounds and no-backfill policy, with insertion/correction/duplicate/deletion regressions.

## Steps

1. Define session aggregate semantics from existing event rules. Include support counts, per-currency tips, bits, and whole-session unique chatters where the UI promises them. Decide and test tombstone/correction behavior, community gift parent/children, repeated IDs and late delivery. Add the eviction regression at the model boundary. Run focused desktop tests.
2. Compute from the full persisted session through bounded SQL/streaming aggregation or transactional old/new row contributions. Match persistence fencing and session identity; do not use capped recent-row APIs. Add storage and persistence tests for duplicate/tombstone/gift corrections, restart/reopen and >5,000 rows. Run `cargo test -p videorc-backend storage::tests::` and relevant live-chat tests.
3. Relay aggregates independently of chat rows through current dashboard/history contracts, preserving all mirrors. Wire renderer stats to confirmed totals; hydration and live updates must converge. Run desktop suite/typecheck and fake-provider/window smokes.

## Done criteria and verification

- [x] Focused regressions preserve one sub/$20 tip after >2,000 and >5,000 ordinary messages.
- [x] Duplicate deliveries and gift parent/child pairs are counted once; corrections follow documented semantics.
- [x] Focused provider, cache and rendered-component cases agree across live, reopened and History views; final app probes remain pending.
- [x] Memory remains bounded and no renderer payload contains unbounded message history.
- [ ] `cargo test -p videorc-backend`, `cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings`, `pnpm --filter @videorc/desktop test`, `pnpm typecheck`, `pnpm lint`, `pnpm smoke:live-chat-fake-providers`, and `pnpm probe:comments-window` pass.

## STOP and maintenance

Stop if current persistent data cannot distinguish gift-group overlap or historical duplicate corrections; specify a migration/backfill policy before proceeding. Future event types must define both their list projection and session aggregate contribution.

## Focused execution evidence

The root independently passed 332 desktop cases (331 across fourteen files, plus the final zero-tip characterization), 197 unique Rust cases across storage/delivery/persistence/shared-fixture/RPC/telemetry/lane filters, and ten Node helper cases. Typecheck, lint, global and direct script/JSON formatting, four script syntax checks, Rust format and diff checks pass. Lint retains the existing `captureConfig` hook dependency warning. Shadscan remained 37 with 54 findings immediately before the commit.

Evidence: `/tmp/videorc-fix100-root-desktop.log`, `-activity-final.log`, `-storage.log`, `-livechat.log`, `-persistence.log`, `-fixtures.log`, `-totals.log`, `-observation.log`, `-coalescing.log`, `-inventory.log`, `-node.log`, `-typecheck.log`, `-lint.log`, `-format.log`, `-direct-format.log` and `-rust-format.log` share the same `/tmp/videorc-fix100-root` prefix. No app/E2E ran for this slice. The maintained fake-provider smoke now covers durable counts/activity, reconnect, clear and 6,001-row paid-event retirement; the detached-window probe covers rendered live/reopen/History totals. Their real runs remain part of final acceptance.

The first final delivery run exposed a test expectation that compared undecorated input with an admitted first-message row. The corrected test captures the actual authoritative baseline and preserves exact equality, refusal, counter and event assertions; the final delivery filter passes 67 cases.
