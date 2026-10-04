# Plan 099: Keep new-message counts and chat follow working after buffer rollover

> Fix plan only. Drift check: `git diff --stat 05ff9188..HEAD -- apps/desktop/src/renderer/src/components/stream-manager/chat-pane.tsx apps/desktop/src/renderer/src/components/stream-manager/stream-manager.tsx apps/desktop/src/renderer/src/lib/live-chat-view.ts`.

Implementation should start from release 0.9.129 (`05ff9188`) or newer main in an isolated worktree. Preserve the original checkout's existing user changes, and perform the drift check before editing.

## Status

- Priority: P1
- Effort: M; explicit bounded delivery ownership spans provider, broker and detached state
- Risk: MED; preserve filtering, pinned state, duplicate semantics and snapshot/adoption authority
- Depends on: none
- Category: bug
- Planned at: `05ff9188`, 2026-10-03, release 0.9.129
- Confidence: HIGH; component runtime confirms unread failure, pinned follow needs runtime regression

## Problem and reproduction

The renderer retains at most 2,000 chat messages. Once full, an appended message evicts another and the list length stays constant. Stream Manager uses length growth to count unread messages; while reading older chat, the streamer stops seeing a new-message count even as new messages arrive.

Seed 2,000 equal-height matching messages with local fake providers, scroll away from the bottom, and deliver three fresh messages. Expect unread +3 and a working jump-to-latest action. Current code calculates zero. Also test pinned follow with equal-height rollover rows; ResizeObserver must not be the only trigger for following new messages.

Exploratory component reproduction used the real `ChatPane` and production bounded-buffer reducer in happy-dom. After scrolling back, 1,999→2,000 correctly showed “1 new”; the next arrival rolled the buffer over but the actual button still showed “1 new”, failing the expected “2 new” assertion. The virtualizer was stubbed to isolate scroll/count state; pinned-follow behavior was not proven by this probe. Evidence: `/tmp/videorc-qa-chat-rollover-component.log`; temporary test/config outside the repository, no application source changes.

The same runtime sequence mounted the actual `StreamManager` with its Chat pane reported hidden. Its Chat tab badge also stayed at 1 instead of 2. This is a second consumer of the same length-based arrival signal, covered by this plan rather than a separate duplicate plan.

## Current state

- `lib/live-chat-view.ts:18` caps the live view at 2,000; `boundMessages` around line 259 slices away oldest messages.
- `applyLiveChatMessage` around line 294 bounds the newly inserted list.
- `components/stream-manager/chat-pane.tsx:193` keeps `previousCount` and the new-chat effect around line 239 does:

```tsx
const added = shown.length - previousCount.current
previousCount.current = shown.length
// ... unread increments only if added > 0
```

The effect depends on `[shown.length, virtualizer]`. Identity/arrival changes are not the unread signal.

- `stream-manager.tsx:107` implements `useUnseen(count, visible)` as `count - seen`; lines 397–409 feed message, activity-item and open-question lengths into it. A full-buffer Chat tab demonstrably freezes too. Add characterization for bounded Activity rollover and equal-count question replacement; only count fresh identities under the respective pane's documented semantics.

Match `live-chat-view.test.ts` for duplicate/tombstone fixtures and existing chat scroll helper tests for pinned behavior. Use a small pure arrival helper with meaningful component integration coverage, not snapshots that mirror the implementation.

## Scope

`chat-pane.tsx`, `stream-manager.tsx`, their tests, a small shared arrival helper/test if needed, and `live-chat-view.ts` only if a monotonic delivery signal belongs there. Keep the 2,000 cap. Do not rewrite virtualization, change platform filters, or count history hydration as incoming chat.

## Execution preparation

The backend already has a session-local `unread_count` that advances for admitted new IDs and resets at session start/clear. It excludes retained duplicates and tombstone updates, but the renderer increment reducer does not advance `unreadCount` and incremental events carry individual messages, not this counter. The value therefore cannot simply replace retained row length. Read actual incremental delivery, bootstrap replay, batching and comments-window snapshot/delta paths before choosing the arrival owner. A snapshot replacement is hydration, not evidence that every newly visible identity just arrived; filter changes and emote refreshes also must not count. Backend dedupe is itself bounded: trimmed IDs leave `seen`, so avoid claiming lifetime dedupe from a renderer or coordinator ID set. If a narrow explicit delivery signal is necessary, include all shared/window mirrors and bounded batching/reset semantics in scope, rather than guessing by timestamp. Prove multiple arrivals in one render and late/tombstone/duplicate cases in actual consumers.

Delivery has two retained projections: the provider batches events through `live-chat-view.ts`, while the detached cache/window folds raw deltas through `shared/comments-snapshot-delta.ts` before publishing snapshots. Include the latter reducer and its bootstrap/reopen owner when characterizing a delivery signal; avoid repairing only the embedded pane. Main `pushCommentsSnapshot` calls also carry sender-operation/dashboard refreshes, which must not manufacture arrivals or erase valid live delivery progress. Root preparation read both actual reducers and the 16 ms bounded provider batch; their cap is unchanged.

## Steps

1. Add regressions for 1,999→2,000→2,001 and multiple constant-size rollovers with the user unpinned and with the Chat tab hidden. Characterize Activity/question identity replacement as well. Current unread behavior must fail. Run `pnpm --filter @videorc/desktop test chat-pane stream-manager live-chat-view`.
2. Track actual new matching deliveries independently of array length. Use message identity/sequence with explicit snapshot and session reset semantics; filters, deletions, edits and emote refreshes must not inflate unread. Follow pinned chat when its newest matching identity changes. Run focused tests and `pnpm typecheck`.
3. Extend `smoke:live-chat-fake-providers` or `probe:comments-window` to exercise a full buffer and fresh messages both pinned and unpinned, including window reopen. Run both maintained checks.

## Verification and done criteria

- [x] New matching messages increment unread after the cap; jump clears it and reaches the newest row.
- [x] Hidden Chat/Activity tab badges count fresh identities across bounded rollover; question replacement follows its characterized semantics.
- [x] Pinned chat follows each newest message with unchanged total height.
- [x] Duplicate IDs, tombstones, filter changes, emote refreshes and history hydration do not count as fresh deliveries.
- [x] Session replacement/reopen has defined reset behavior.
- [ ] `pnpm --filter @videorc/desktop test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm smoke:live-chat-fake-providers`, and `pnpm probe:comments-window` pass.

## STOP and maintenance

Stop if arrival ownership cannot be distinguished from snapshot hydration with the present data contract; extend a small shared delivery contract explicitly rather than guessing from timestamps. Future chat caps must leave arrival/follow logic independent of retained row count.


## Execution characterization — delivery ownership contract

Actual component regressions now fail under both retained reducers (`/tmp/videorc-fix099-component-red.log`): unpinned unread and hidden Chat/Activity badges stop at rollover, pinned equal-height arrivals trigger no follow, and equal-count question replacement produces no unseen badge. Nine assertions fail; the existing one-message growth step passes. Virtualizer identity is stable, resize notifications are silent and the actual viewport scroll listener is exercised.

Current snapshot rows cannot distinguish hydration from admitted delivery. Retained ID-to-sequence stamps alone also lose a distinct late arrival that chronological trimming removes immediately. Before production edits, define a narrow renderer/main delivery contract with a separately bounded admission journal containing sequence plus delivered message data, unchanged 2,000 paint and 128 pending-message caps, and no lifetime dedupe claim. Normal bursts and late arrivals must remain classifiable against the consumer's actual filter. Define explicit overrun behavior when a consumer skips more admissions than the journal can retain; missing evidence must not silently become zero or a fabricated exact filtered count.

Generation and snapshot ownership must cover independently folded provider/main/detached stores, legacy hydration, incidental snapshots older than raw deltas, clear/session replacement, and batching that replaces an initial message with its tombstone before flush. Snapshot rows never mint arrivals. This is the explicit shared-contract expansion allowed by the original STOP boundary; root will review the concrete design before implementation. Durable whole-session aggregates remain Plan 100's separate scope.


### Approved narrow contract

Root approved an optional renderer/main-owned delivery projection with a local generation, monotonic admission sequence and at most 2,000 `{sequence, message}` journal entries. Each provider/main owner keeps its own sequence; main strips provider-owned delivery metadata from incoming hydration and preserves its own raw-delta admissions. Detached state consumes main-owned snapshots/deltas and begins a reopen at the current baseline. Snapshot rows never mint admissions. Explicit clear is forwarded as a clear delta and rotates ownership; a different session resets it. The 2,000 paint cap and 128 pending-message cap remain unchanged.

Tombstones redact matching journal content and add no admission. Deletion before first observation does not count; already-counted unread remains. Hydration must preserve known tombstones and redact the journal too. Old pre-clear snapshots cannot restore an old journal/unread. Journal overrun yields a known matching lower bound plus incomplete flag; product copy uses ordinary “New chat”/“New” rather than inventing an exact filtered count. Pinned follow independently watches the newest matching retained identity. Safe integer fields, bounded arrays and IPC mirrors require validation and regressions. Different local generations/sequences are never treated as equal authority. Durable analytics and lifetime dedupe remain out of scope.


Owner generations also require a bounded opaque store `ownerId`: a renderer remount cannot be misread as an old generation zero. Main tracks the current provider boundary separately from its own delivery owner. Approval requires explicit owner adoption/publication fences, stale snapshots after repeated remounts, and no unbounded retired-token set. Journal facts may be reduced after tracing all actual chat filters/activity selectors, preserving existing IPC node/byte limits. Provider clear followed by its replacement snapshot must not reset main's admitted post-clear progress twice.


The final approved adoption boundary uses the existing authenticated `pushCommentsDelta` transport with an `adopt` control kind. Provider adopts synchronously once in its current backend-client effect before subscriptions/bootstrap publication; no delayed adoption retries. Main authorizes that provider owner/generation separately from its broker-owned journal. Adoption adds no arrival and does not clear same-session main progress. Detached authority remains broker-owned; provider adoption is not permission to replace its journal. Tests must cover repeated A→B→C remounts followed by stale A/B snapshots without a retired-ID set, ordered adoption/raw deltas/bootstrap, reconnect and legacy hydration. Journal fields are reduced to actual filter/activity facts after tracing selectors, excluding avatars/fragments and paid values, to retain the existing IPC limits.


Draft review requires source validation before any initial/different-session hydration branch, and preservation of the adopted publisher boundary when the receiver's first session ID appears. Otherwise adoption-before-bootstrap loses its source fence, or an old owner can bypass the fence by naming a different session. Add regressions for both before handoff; these are review findings inside this implementation slice, not additional closed bugs.


Actual provider wiring must adopt each current publication generation before its snapshot, in addition to the initial client-effect adoption before subscriptions/bootstrap. First-session and later session hydration can change the provider's local journal generation. A shared synchronous publication wrapper fences obsolete asynchronous generations; clear carries its explicit new boundary. This refines the initial once-per-client description so source authority remains correct through session transitions without assuming receiver generation equality. Meaningful actual-provider transport coverage is required before handoff.


The initial eleven actual consumer cases are green. Further draft review requires a valid post-clear authoritative backend recovery path: Rust snapshots carry no local delivery metadata, so a generic “cleared” rejection cannot permanently block provider recovery. Cover a delayed pre-clear response and a valid post-clear response through the actual provider, without minting arrivals from either snapshot. Legacy unsourced broker hydration and generation-fenced authoritative backend hydration have different authority and must remain distinguishable.

Suspended recovery can discard an overflowed 128-message candidate before a successful retry. The provider therefore needs explicit uncertainty beyond the journal's own retention overrun. Root approved optional safe-integer `lossRevision` on local delivery metadata/cursors: advance only for an owned, observed recovery/bootstrap queue overflow; never turn hydrated rows into admissions. Consumers observe a newer loss revision once and show ordinary “New chat”/“New” instead of an exact filtered count. Clear/session reset clears that uncertainty. Main keeps its independent raw-delta journal and does not import the provider's loss signal. The actual-provider deferred recovery case failed before this change and now passes; final focused verification is still in progress.

## Execution status — implemented, final app acceptance pending

Commit `d5729943bdac6fe434317fcc420c240677f4a4ce` merged through [PR 555](https://github.com/TheOrcDev/videorc/pull/555), main `325cba819e3588821a8e3adeb92c4045c6e11ce3`. Twenty-one intentional source/test/probe files implement the approved bounded delivery contract. Provider and broker keep independent journals; detached state follows broker authority. Ordered adoption precedes bootstrap and every current publication generation. Stale publishers cannot authorize older snapshots after clear, reconnect, session change or repeated remounts. Initial/History/reopened snapshots establish a baseline and never mint arrivals. Paint and journal caps remain 2,000, with the pending queue unchanged at 128.

Actual consumers cover unpinned/pinned equal-height rollover, multiple arrivals in one render, hidden Chat/Activity badges, equal-count question replacement, immediately trimmed late messages, duplicate/deletion/emote/hydration behavior, clear/session reset, History return and incomplete evidence. Reduced journal facts match all production filters and Activity detail kinds, including community gift suppression; they omit fragments, avatars and paid values. Tombstones redact journal content even when the corresponding painted row was trimmed. Safe integers, contiguous journal sequences, strict metadata fields and existing IPC limits are verified; a representative 2,000 paid-row plus 2,000 journal-entry projection remains within those limits. Observed recovery/bootstrap queue loss advances uncertainty without adding admissions, while main retains every independently received raw arrival.

Executor covered 263 unique focused desktop cases and six Node harness cases. Root independently passed 266 desktop cases across ten files, including all 146 actual provider cases and 15 actual consumer cases, plus the same six Node cases. Typecheck, lint (one existing captureConfig hook warning), global/direct formatting, script syntax and diff checks passed. Shadscan stayed 37 immediately before commit. Root logs: `/tmp/videorc-fix099-root-{focused,node,typecheck,lint,format}.log`.

Maintained `probe:comments-window` now seeds the full buffer, verifies pinned newest-identity follow, three unpinned raw arrivals surviving incidental old hydration, jump and reopen. Missing readiness evidence fails its bounded harness. That real-app probe, fake-provider smoke and full suites run after the complete batch; no app or E2E ran for this slice. Durable whole-session totals remain Plan 100. Shared visibility fixture repair (114) and default production asset repair (113) remain separate required follow-ups before final acceptance.
