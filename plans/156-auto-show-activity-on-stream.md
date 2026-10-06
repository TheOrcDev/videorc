# Plan 156: Auto-show Activity on stream — one switch

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's entry in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 2337a317..HEAD -- apps/desktop/src plans scripts/comments-window-probe.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 (feature; manual "Show on stream" already exists per row,
  so nothing is broken — but mid-stream nobody has a hand free to click it)
- **Effort**: M, 6 slices
- **Risk**: MED (writes to the live stream overlay; a bug is visible to
  viewers — bounded by reusing the existing highlight slot unchanged)
- **Depends on**: none
- **Category**: direction (feature)
- **Planned at**: commit `2337a317`, 2026-10-06

## Why this matters

The Stream Manager's Activity pane (plan 055, D4) lists every follow, sub,
membership, gift, tip, raid and watch streak, and each row has a manual
"Show on stream" action that puts the matching chat row on the stream as the
existing glass highlight card (plan 095, S2). Mid-stream, the streamer is
talking and playing; they asked for one switch that makes those events pop
onto the stream automatically, so a new follower or gifter is thanked on
screen without anyone touching the window. This plan adds that switch and an
auto-show engine that reuses the existing highlight path end to end — no new
overlay, no new backend RPC, no new render path.

## Design decisions (confirm-or-override list for the owner)

- **D1 — Reuse the highlight slot verbatim.** Auto-show calls the same
  renderer path as a manual click (`applyCommentHighlight` →
  `comments.highlight.set`), so the card, its 10 s backend TTL
  (`HIGHLIGHT_AUTO_DISMISS_MS` twin in Rust), the streamer's corner pick and
  every existing smoke keep applying. The backend stays untouched.
- **D2 — What auto-shows.** A chat-message-backed celebration:
  `message.details.kind` in `follow`, `subscription`, `membership`, `cheer`,
  `kicks`, `super-chat`, `super-sticker`, `raid`, `watch-streak`, passing
  `commentCanHighlight`. Never `announcement` (the streamer's or a mod's own
  system text, not a viewer celebration), and never destination rows or
  unnamed follower-count gains (no chat row behind them; destination health
  must never leak on stream). A single `sub-gift` that carries a
  `communityGiftId` is skipped — its community notice fires once for the
  whole bomb, matching how Activity lists it.
- **D3 — Manual always wins; auto never un-pins.** Auto fires only when the
  slot phase is `idle` and no apply is in flight
  (`commentHighlightApplyingId === null`), with always-set semantics. It
  never replaces a live card (manual, Orcle or a previous auto one) and never
  reads a repeat as "take off stream". This mirrors the Orcle engine
  auto-highlight contract already in `use-studio.tsx` (see Current state).
- **D4 — Bounded queue, newest-biased.** While a card is live, eligible
  events queue FIFO: cap 3 pending, drop anything older than 30 s at drain
  time, dedupe by `messageId`. A quiet stream shows everything; a hype train
  shows a rolling sample instead of a ten-minute backlog of stale thanks.
- **D5 — The switch is owned by Electron main, default OFF.** It persists in
  the comments-window prefs file exactly like `highlightAnchor` (which was
  moved to main so highlights fired with the window closed still honour the
  pick), travels in `CommentsWindowState`, and is set over a new narrow IPC
  channel. UI home: a labeled switch in the Activity pane's header row.
- **D6 — Execution lives in the main (Studio) renderer.** The Stream Manager
  window has no backend socket (every value reaches it relayed through main
  — plan 155's execution record spells this out), and only the Studio
  renderer can rasterize the card. The watcher therefore lives in
  `use-studio.tsx`, next to the Orcle auto-highlight executor, and works even
  while the Stream Manager window is closed.
- **D7 — Live sessions only, from "now".** The seen-set seeds on session
  change and on flipping the switch ON, so a backlog, a History view, or a
  mid-stream enable never replays old events onto the stream.

## Current state

Files, each with its role:

- `apps/desktop/src/renderer/src/lib/stream-activity.ts` — the pure Activity
  projection; `activityItems` maps `LiveChatMessage.details` to rows and
  already collapses community-gift singles (lines 401–434).
- `apps/desktop/src/renderer/src/lib/live-chat-view.ts:505-519` —
  `commentCanHighlight(message)`: notices (`system`/`membership`/`follow`
  event types) are highlightable only when they carry `details`.
- `apps/desktop/src/renderer/src/components/stream-manager/activity-pane.tsx`
  — the pane; header row with filter `ToggleGroup`s (lines 347–398), rows
  with the manual "Show on stream" action.
- `apps/desktop/src/renderer/src/components/stream-manager/stream-manager.tsx`
  — composes the panes; `showActivityOnStream` resolves an `ActivityItem` to
  its message and calls `onHighlight` (lines 684–687).
- `apps/desktop/src/renderer/comments/main.tsx` — the window's root; reads
  `CommentsWindowState` on mount and subscribes to `onCommentsWindowState`
  (lines 199–233); `onHighlightAnchorChange` calls
  `setCommentsWindowHighlightAnchor` (lines 718–722) — the wiring pattern for
  the new switch.
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx` — the Studio renderer:
  - `commentsWindow` state + `onCommentsWindowState` subscription
    (lines 2575–2605); `idleCommentsWindowState` default shape (line 1842).
  - `applyCommentHighlight(message, sessionId, intent, { alwaysSet })`
    (lines 2754–2851) — the one highlight apply path (avatar cache, card
    raster, `comments.highlight.set`, failure reconciliation).
  - The Orcle engine auto-highlight executor and its guard — the contract D3
    copies:

```4303:4310:apps/desktop/src/renderer/src/hooks/use-studio.tsx
  executeCohostAutoHighlightRef.current = (messageId) => {
    // A card the streamer is setting by hand (H pressed, PNG still
    // rendering) always wins: the engine only sees the backend phase, which
    // is still idle while the manual apply is in flight. The engine reclaims
    // an unserved command after its apply timeout.
    if (commentHighlightApplyingId !== null) return
    const message = liveChatSnapshotRef.current.messages.find(
      (candidate) => candidate.id === messageId
```

  - `comments.highlight.status` backend events land in
    `publishCommentHighlightState` (line 6910), so `commentHighlightState`
    flipping back to `idle` is the drain signal after a card expires.
- `apps/desktop/src/main/index.ts` — main-process ownership:
  - `CommentsWindowPrefs` (line ~2912) with `highlightAnchor`;
    `commentsHighlightAnchor()` lazy load + `setCommentsWindowHighlightAnchor`
    (lines 2956–2968); `commentsWindowState()` (line 2984);
    `emitCommentsWindowState` (line 3415); `secureIpcHandle`
    `'comments-window:set-highlight-anchor'` (line ~14165); smoke command
    `'comments-window-set-highlight-anchor'` in the dev smoke dispatcher
    (line ~10583).
- `apps/desktop/src/shared/backend.ts` — `CommentsWindowState` (line 4118)
  and the `VideorcApi` method list (line ~4405).
- `apps/desktop/src/shared/electron-ipc-contract.ts` — channel→method map
  (line 147 area), specific runtime contract for
  `'comments-window:set-highlight-anchor'` (line 1233), the boolean
  exemplar `'shortcut-recorder:set-armed'` (line 1333).
- `apps/desktop/src/shared/renderer-security-policy.ts:102-103` —
  `MAIN_AND_COMMENTS` role entries for the comments-window channels.
- `apps/desktop/src/preload/index.ts:144-148` and
  `apps/desktop/src/preload/api-policy.ts:42-45` — preload bridge + comments
  window API allowlist.
- `apps/desktop/src/main/smoke-command-security.ts:54` — dev smoke command
  allowlist (`'comments-window-set-highlight-anchor'`).
- `scripts/comments-window-probe.mjs:261-285` — the probe already drives
  `comments-window-set-highlight-anchor` and asserts the state round trip —
  the pattern for probing the new switch.
- `apps/desktop/src/renderer/src/components/ui/switch.tsx` — the existing
  Switch component (use it; do not hand-roll a toggle).

Conventions to match: pure helpers for behaviour that needs tests (AGENTS.md
Style), dense work-focused controls using the existing component system,
`data-slot` attributes for test hooks, and comments that cite the plan
("plan 156") the way `activity-pane.tsx` cites plans 055/071/095.

## Commands you will need

| Purpose            | Command                                      | Expected on success           |
| ------------------ | -------------------------------------------- | ----------------------------- |
| Install            | `pnpm install`                               | exit 0                        |
| Typecheck          | `pnpm typecheck`                             | exit 0                        |
| Lint               | `pnpm lint`                                  | exit 0 (one pre-existing warning in `use-studio.tsx` is known) |
| Format             | `pnpm format:check`                          | exit 0                        |
| Desktop unit tests | `pnpm --filter @videorc/desktop test`        | all pass                      |
| Highlight smoke    | `pnpm smoke:comment-highlight-stream`        | exit 0 (macOS host only)      |
| Window probe       | `pnpm probe:comments-window`                 | exit 0 (macOS host only)      |
| Studio gate        | `pnpm smoke:recording-studio`                | exit 0 (macOS host only)      |

The three smoke/probe commands launch the Electron dev app and need a macOS
host with a display; on headless Linux, run everything else and state in the
handoff that the smokes are owed (AGENTS.md: do not hand off recording-studio
work with only typecheck/lint — if the smoke is blocked, say why).

## Scope

**In scope** (the only files you should modify or create):

- `apps/desktop/src/renderer/src/lib/activity-auto-highlight.ts` (create)
- `apps/desktop/src/renderer/src/lib/activity-auto-highlight.test.ts` (create)
- `apps/desktop/src/renderer/src/components/stream-manager/activity-pane.tsx`
- `apps/desktop/src/renderer/src/components/stream-manager/activity-pane.test.ts`
- `apps/desktop/src/renderer/src/components/stream-manager/stream-manager.tsx`
- `apps/desktop/src/renderer/comments/main.tsx`
- `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/smoke-command-security.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/preload/api-policy.ts`
- `apps/desktop/src/shared/backend.ts`
- `apps/desktop/src/shared/electron-ipc-contract.ts`
- `apps/desktop/src/shared/electron-ipc-contract.test.ts`
- `apps/desktop/src/shared/renderer-security-policy.ts`
- `apps/desktop/src/main/renderer-security-policy.test.ts`
- `scripts/comments-window-probe.mjs`
- `plans/README.md`, this file (status updates)

**Out of scope** (do NOT touch, even though they look related):

- `crates/videorc-backend/**` — the highlight slot, TTL and anchor behaviour
  are already right; this feature is renderer policy only.
- `apps/desktop/src/renderer/src/lib/comment-highlight.ts` and the caption
  overlay painter — the card itself does not change.
- The Orcle engine auto-highlight (`cohostState.autoHighlight`) and its
  executor — coexistence only (D3), no edits.
- Phone remote / LAN surfaces (`remote_lan*`, `remote-surface.ts`) — the
  switch is not exposed remotely in this plan.
- `apps/desktop/src/renderer/src/lib/stream-activity.ts` — the Activity
  projection is read, not changed.

## Git workflow

- Branch: `cursor/156-auto-show-activity-<suffix>` (match the repo's
  `cursor/<slug>` convention seen in plans 154/155).
- One commit per slice, imperative messages like the log (`feat: …`,
  `test: …`).
- Do not push or open a PR unless the operator instructed it.

## Steps

### S1: Pure auto-show policy module + tests

Create `apps/desktop/src/renderer/src/lib/activity-auto-highlight.ts` with no
React imports (model the module header comments on `stream-activity.ts`):

```ts
import type { LiveChatMessage } from '@/lib/backend'
import { commentCanHighlight } from '@/lib/live-chat-view'

/** Celebrations the switch auto-shows (plan 156, D2). */
export const AUTO_SHOW_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  'follow', 'subscription', 'membership', 'cheer', 'kicks',
  'super-chat', 'super-sticker', 'raid', 'watch-streak'
])
export const AUTO_SHOW_MAX_PENDING = 3
export const AUTO_SHOW_MAX_AGE_MS = 30_000

export function activityAutoShowEligible(message: LiveChatMessage): boolean
// details present, kind in the set, not a community-gift single
// (details.kind === 'subscription' && details.subscription === 'sub-gift'
//  && details.communityGiftId), commentCanHighlight(message) true.

export interface AutoShowQueue {
  /** Message ids already considered this session (never re-fired). */
  seen: ReadonlySet<string>
  /** Eligible ids waiting for the slot, oldest first. */
  pending: readonly string[]
}

export function seedAutoShowQueue(messages: readonly LiveChatMessage[]): AutoShowQueue
// seen = every current message id, pending = [] — used on session change
// and when the switch turns ON (plan 156, D7).

export function enqueueAutoShow(
  queue: AutoShowQueue,
  messages: readonly LiveChatMessage[]
): AutoShowQueue
// Adds unseen eligible message ids to pending (and ALL unseen ids to seen,
// eligible or not, so scanning stays O(new)). Keeps at most
// AUTO_SHOW_MAX_PENDING pending, dropping the OLDEST overflow. Returns the
// same object when nothing changed (referential stability for effects).

export function takeNextAutoShow(
  queue: AutoShowQueue,
  messages: readonly LiveChatMessage[],
  nowMs: number
): { queue: AutoShowQueue; message: LiveChatMessage | null }
// Pops pending head-first, skipping ids whose message is gone, deleted, or
// whose receivedAt is more than AUTO_SHOW_MAX_AGE_MS before nowMs. Returns
// the first still-fresh message, or null.
```

Write `activity-auto-highlight.test.ts` beside it (vitest, model the
structure on `stream-activity.test.ts` — plain `describe`/`it` over the pure
functions; its message fixtures show the exact `LiveChatMessage` shapes for
every `details.kind`).

**Verify**: `pnpm --filter @videorc/desktop test -- activity-auto-highlight`
→ all new tests pass. `pnpm typecheck` → exit 0.

### S2: The setting — prefs, state, IPC, smoke command

All plumbing mirrors `highlightAnchor` line for line; keep the pieces small
and adjacent to the anchor code so the symmetry is reviewable.

1. `apps/desktop/src/shared/backend.ts`: add
   `autoShowActivity: boolean` to `CommentsWindowState` (after
   `highlightAnchor`, with a doc comment: owned by main so the engine runs
   with the window closed; default false), and
   `setCommentsWindowAutoShowActivity: (on: boolean) => Promise<CommentsWindowState>`
   to `VideorcApi` next to `setCommentsWindowHighlightAnchor`.
2. `apps/desktop/src/shared/electron-ipc-contract.ts`: map
   `'comments-window:set-auto-show-activity': 'setCommentsWindowAutoShowActivity'`
   beside the anchor channel, and add a specific runtime contract
   `invokeContract(tupleSchema([booleanSchema]))` (the
   `'shortcut-recorder:set-armed'` entry at line 1333 is the boolean
   exemplar). Do NOT add it to the bounded-passthrough list.
3. `apps/desktop/src/shared/renderer-security-policy.ts`:
   `'comments-window:set-auto-show-activity': MAIN_AND_COMMENTS`.
4. `apps/desktop/src/preload/index.ts`:
   `setCommentsWindowAutoShowActivity: (on) => invoke('comments-window:set-auto-show-activity', on)`.
   `apps/desktop/src/preload/api-policy.ts`: add the method name to the
   comments-window list beside `setCommentsWindowHighlightAnchor`.
5. `apps/desktop/src/main/index.ts`:
   - `CommentsWindowPrefs`: add `autoShowActivity?: boolean`.
   - A lazy module value + getter like `commentsHighlightAnchor()`:
     `commentsAutoShowActivity(): boolean` reading the pref (`=== true`, so a
     missing or forged value lands on OFF), and
     `setCommentsWindowAutoShowActivity(on: unknown): CommentsWindowState`
     coercing with `Boolean(on)`, saving prefs, calling
     `emitCommentsWindowState()` and returning `commentsWindowState()`.
   - Include `autoShowActivity: commentsAutoShowActivity()` in
     `commentsWindowState()`.
   - `secureIpcHandle('comments-window:set-auto-show-activity', (_event, on) => setCommentsWindowAutoShowActivity(on))`
     next to the anchor handler.
   - Dev smoke command `'comments-window-set-auto-show-activity'` in the
     smoke dispatcher next to `'comments-window-set-highlight-anchor'`,
     calling the same setter, and add the name to
     `apps/desktop/src/main/smoke-command-security.ts`.
6. Defaults: update `idleCommentsWindowState` in `use-studio.tsx` (line 1842)
   and any other literal `CommentsWindowState` constructions the typecheck
   flags (`comments-header.test.ts:124` has one fixture) with
   `autoShowActivity: false`.

Tests: extend `electron-ipc-contract.test.ts` (model on the anchor test at
line 315: booleans pass, strings/numbers/missing throw) and
`renderer-security-policy.test.ts` (model on lines 388–392: main and comments
may invoke, notes/captions may not; `AUXILIARY_API_KEYS.comments` contains
the method).

**Verify**: `pnpm typecheck` → exit 0 (this is the step that proves every
`CommentsWindowState` literal was updated).
`pnpm --filter @videorc/desktop test -- electron-ipc-contract renderer-security-policy`
→ all pass.

### S3: The switch in the Activity pane header

1. `activity-pane.tsx`: add optional props
   `autoShow?: boolean` and `onAutoShowChange?: (on: boolean) => void`. When
   `onAutoShowChange` is present, render at the right end of the existing
   header row (after the platform `ToggleGroup`, pushed right with
   `ml-auto`): a `Switch` (from `@/components/ui/switch`) with an adjacent
   `text-xs` label "Auto-show", `data-slot="activity-auto-show"`, and
   `title`/`aria-label`:
   "Automatically show new follows, subs, gifts, tips, raids and streaks on
   stream for a few seconds". Keep the control dense (size it like the `h-6`
   chips beside it); no new icons.
2. `stream-manager.tsx`: thread `autoShowActivity?: boolean` and
   `onAutoShowActivityChange?: (on: boolean) => void` through
   `StreamManagerProps` into `<ActivityPane autoShow onAutoShowChange>`.
   Pass `onAutoShowChange` only when the window is in live mode is NOT
   required — the setting is global, so pass it unconditionally.
3. `comments/main.tsx`: hold `autoShowActivity` in the same state the window
   already fills from `getCommentsWindowState` / `onCommentsWindowState`
   (lines 199–233), and wire
   `onAutoShowActivityChange={(on) => void window.videorc?.setCommentsWindowAutoShowActivity?.(on)}`
   exactly like the anchor change at lines 718–722 (optimistic local set,
   main's state event is the truth).

Tests: extend `activity-pane.test.ts` (it renders the pane with
`renderToStaticMarkup`): the switch renders with
`data-slot="activity-auto-show"` and reflects `autoShow`; absent
`onAutoShowChange` renders no switch.

**Verify**: `pnpm --filter @videorc/desktop test -- activity-pane` → pass.
`pnpm lint` → no new warnings.

### S4: The auto-show engine in the Studio renderer

In `use-studio.tsx`, directly below the Orcle auto-highlight block
(lines 4293–4340), add the plan-156 watcher. Shape:

- Refs/state: `const activityAutoShowQueueRef = useRef<AutoShowQueue>(seedAutoShowQueue([]))`,
  plus a `useRef<string | null>` for the session the queue was seeded for and
  a `useRef<boolean>` for the previous switch value.
- Enabled means: `commentsWindow.autoShowActivity === true` AND
  `liveChatSnapshot.sessionId` is set.
- One effect keyed on
  `[liveChatSnapshot, commentsWindow.autoShowActivity, commentHighlightState.phase, commentHighlightApplyingId]`:
  1. If the session id changed or the switch just flipped ON: reseed with
     `seedAutoShowQueue(liveChatSnapshot.messages)` and return (D7 — never
     replay the backlog).
  2. If disabled: return (keep the seen-set current via reseed on next
     enable; pending is discarded by the reseed).
  3. `enqueueAutoShow(queue, liveChatSnapshot.messages)`.
  4. Fire only when `commentHighlightState.phase === 'idle'` AND
     `commentHighlightApplyingId === null` (D3):
     `takeNextAutoShow(queue, liveChatSnapshot.messages, Date.now())`; when
     it returns a message, run the exact Orcle-auto execution shape — bump
     `commentHighlightIntentRef`, `applyCommentHighlight(message, undefined,
     intent, { alwaysSet: true })`, publish on success, reconcile from
     `comments.highlight.status` on failure, never toast (failures stay
     quiet; the backend's status is the truth). Copy the promise handling
     from `executeCohostAutoHighlightRef.current` verbatim rather than
     inventing a new one.
- Drain-on-expiry needs no timer: when the backend expires the card it pushes
  `comments.highlight.status`, `publishCommentHighlightState` sets the phase
  to `idle`, and the effect above re-runs and pops the next pending event.

Add a comment block naming the contract, in the codebase's voice:
"Plan 156: the Activity auto-show engine. Manual and Orcle cards always win —
auto only fires into an idle slot, never un-pins, and a backlog or History
view never replays (the queue reseeds on session change and switch-on)."

**Verify**: `pnpm typecheck` → exit 0; `pnpm --filter @videorc/desktop test`
→ all pass; `pnpm lint` → no new warnings (the hook-deps warning must not
grow — use refs the way the Orcle block does if the effect deps fight you).

### S5: Probe coverage

Extend `scripts/comments-window-probe.mjs` next to the anchor probe
(lines 261–285): drive `comments-window-set-auto-show-activity` with `true`,
assert the returned state (and a fresh `comments-window-get-state` if the
probe uses one) carries `autoShowActivity: true`, flip it back to `false`,
and assert a forged non-boolean (`'yes'`) coerces or is refused without
crashing main (match whichever the setter does — `Boolean('yes')` is `true`,
so assert that, mirroring how the anchor probe asserts normalisation).

**Verify**: on a macOS host, `pnpm probe:comments-window` → exit 0. On
headless Linux, state the probe is owed and verify instead:
`node --check scripts/comments-window-probe.mjs` → exit 0.

### S6: Record and hand off

Update `plans/README.md` (this plan's entry: status, branch) and the status
header of this file. Run the full local gate set from the Commands table.
In the handoff, list the macOS-only gates that were or were not run
(`smoke:comment-highlight-stream`, `probe:comments-window`,
`smoke:recording-studio`) — AGENTS.md requires the recording-studio gate for
anything touching recording output surfaces; this plan touches what the
stream shows, so run it on macOS before merge or say explicitly why not.

## Test plan

New tests, all under the existing vitest setup
(`pnpm --filter @videorc/desktop test`):

- `lib/activity-auto-highlight.test.ts` (new; model on
  `lib/stream-activity.test.ts` fixtures):
  - eligibility: one case per auto-shown `details.kind`; announcement,
    deleted message, details-less notice, and community-gift single all
    refused; the community notice itself accepted.
  - seeding: `seedAutoShowQueue` marks the backlog seen with empty pending.
  - enqueue: unseen eligible ids append; ineligible ids become seen but not
    pending; overflow past `AUTO_SHOW_MAX_PENDING` drops the oldest;
    unchanged input returns the same reference.
  - take: pops in FIFO order; skips vanished, deleted and stale
    (> 30 s) entries; returns null on empty.
- `shared/electron-ipc-contract.test.ts`: the new channel accepts `[true]` /
  `[false]`, throws on `['yes']`, `[1]`, `[]`.
- `main/renderer-security-policy.test.ts`: main and comments can invoke the
  new channel; notes and captions cannot; the preload key is exposed to the
  comments window.
- `components/stream-manager/activity-pane.test.ts`: switch renders, reflects
  `autoShow`, absent handler hides it.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0 with no new warnings
- [ ] `pnpm format:check` exits 0
- [ ] `pnpm --filter @videorc/desktop test` exits 0, including the new
      `activity-auto-highlight`, contract, policy and pane tests
- [ ] `rg -n "autoShowActivity" apps/desktop/src/shared/backend.ts apps/desktop/src/main/index.ts` shows the state field and the prefs plumbing
- [ ] The switch defaults OFF: `rg -n "autoShowActivity" apps/desktop/src` shows no `?? true` / `=== undefined → true` path
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] On macOS: `pnpm probe:comments-window` and
      `pnpm smoke:comment-highlight-stream` exit 0, and
      `pnpm smoke:recording-studio` was run before handoff (or the handoff
      names the blocked environment)
- [ ] `plans/README.md` entry updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" no longer match the live code (drift) —
  especially the Orcle auto-highlight guard block in `use-studio.tsx` or the
  `highlightAnchor` plumbing in `main/index.ts`.
- You find yourself needing a backend (Rust) change to make the slot behave —
  that means D1 is violated; the plan assumed renderer-only policy.
- The effect in S4 cannot avoid firing on History views or backlog replays
  without touching `stream-activity.ts` or the snapshot relay.
- `commentHighlightApplyingId` or `commentHighlightState` are no longer
  readable at the S4 insertion point (the hook was restructured).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Orcle coexistence**: the Orcle engine's `autoHighlight` and this watcher
  both fire only into an idle slot, so they interleave rather than fight; if
  either ever gains preemption, revisit D3 in both places together.
- **Rate feel is policy, not plumbing**: `AUTO_SHOW_MAX_PENDING` (3) and
  `AUTO_SHOW_MAX_AGE_MS` (30 s) plus the backend's 10 s card TTL define the
  worst-case "thank-you lag". Tune the two constants, not the queue shape.
- **Future per-kind filters** ("auto-show tips but not follows") should
  extend `AUTO_SHOW_ACTIVITY_KINDS` into a persisted set behind the same
  switch, not grow a second switch per kind in the pane header.
- **Phone remote**: exposing the switch over `remote_lan` needs a leak
  argument per AGENTS.md before any route is added — deliberately deferred.
- **Reviewer focus**: the S4 effect's reseed conditions (session change,
  switch-on) are the regression hotspot — a wrong dep array replays the
  whole backlog on stream. The second hotspot is D2's announcement/destination
  exclusion: nothing private may auto-appear on stream.
