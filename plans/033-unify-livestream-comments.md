# Plan 033: Make Comments the authoritative multi-platform live interaction surface

> **Executor instructions**: One execution unit is exactly one named U-slice.
> If the dispatcher names no slice, take the first `TODO` row whose prior-slice
> dependencies are `PASS`. If its external precondition is missing, record that
> slice `BLOCKED` with the reason and stop; otherwise mark it `IN PROGRESS`, run
> only that slice and its verification,
> then record `PASS`, `FAIL`, or `BLOCKED` in the ledger and stop for review.
> Never roll automatically into the next slice. If anything in the "STOP
> conditions" section occurs, stop and report — do not improvise. Update the
> overall row in `plans/README.md` only when the plan-level status changes.
>
> **Drift check (run first)**:
>
> ```sh
> scope=(
>   crates/videorc-backend/src/{live_chat,youtube,youtube_chat,twitch_chat,x_chat,oauth,preflight,storage,main,state,captions,compositor,recording}.rs
>   crates/videorc-backend/src/comment_highlight.rs
>   apps/desktop/src/{main/index,preload/index,shared/backend}.ts
>   apps/desktop/src/main/{comments-command-broker,comments-command-broker.test}.ts
>   apps/desktop/src/renderer/comments/main.tsx
>   apps/desktop/src/renderer/src/hooks/use-studio.tsx
>   apps/desktop/src/renderer/src/components/{comments-reader,live-chat-panel,live-chat-rail,chat-platform-icon,go-live-dialog}.tsx
>   apps/desktop/src/renderer/src/components/{comment-row,comment-row.test,comments-destination-status,comments-destination-status.test}.tsx
>   apps/desktop/src/renderer/src/components/ui/avatar.tsx
>   apps/desktop/src/renderer/src/components/tabs/{library-tab,studio-tab,streaming-tab}.tsx
>   apps/desktop/src/shared/{comments-send-operation,comments-send-operation.test}.ts
>   apps/desktop/src/renderer/src/lib/{chat-send,comment-highlight,live-chat-view,caption-overlay,capture}.ts
>   apps/desktop/src/renderer/src/lib/{chat-send,comment-highlight,live-chat-view,caption-overlay,capture}.test.ts
>   scripts/{smoke-live-chat-fake-providers,comments-window-probe,ui-theme-screens}.mjs
>   scripts/smoke-oauth-guards-app.mjs
>   scripts/smoke-comment-highlight-stream-app.mjs
>   scripts/lib/{comment-highlight-artifact,comment-highlight-artifact.test}.mjs
>   scripts/lib/{recording-studio-gates,recording-studio-gates.test}.mjs
>   package.json
>   docs/live-chat-live-smoke-checklist.md
>   docs/oauth-live-smoke.md
>   docs/acceptance/{2026-07-05-comments-window-upgrade,2026-07-10-unified-livestream-comments}.md
>   plans/033-unify-livestream-comments.md
>   plans/README.md
> )
> git diff --stat 90a7129b..HEAD -- "${scope[@]}"
> git status --short -- "${scope[@]}"
> ```
>
> First make this plan available on a clean branch or isolated worktree. The
> second command must print nothing before U0 begins. The checkout used to
> write this plan already had unrelated native-preview edits in seven in-scope
> files (`main/index.ts`, `use-studio.tsx`, `capture.ts`, `backend.ts`, backend
> `main.rs`, `state.rs`, and root `package.json`), so it is not an execution
> worktree. Never reset, overwrite, or absorb those edits. If the first command
> prints changes, compare the "Current state" excerpts against live code; stop
> on a semantic mismatch and update the plan before implementation.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH — provider APIs, OAuth, cross-window IPC, persisted chat state,
  and the viewer-facing compositor are all involved
- **Depends on**: Plans 028 and 029 for native X read access; external Google
  OAuth approval for production YouTube comments; a documented X native-chat
  write contract for literal three-chat outbound fan-out
- **Category**: tech-debt
- **Planned at**: commit `90a7129b`, 2026-07-10
- **Current delivery boundary**: the internal slices are executable now. The
  exact requirement "send to YouTube, Twitch, and X native live chat" is
  externally blocked because Videorc's approved X Livestream API documents
  chat as read-only. Do not mark this plan DONE while that requirement remains
  unchanged and X has no approved write path.
- **Execution outcome (2026-07-10)**: Milestone A implementation and
  account-free acceptance pass. The real YouTube/Twitch/X account rows and the
  isolated-worktree ScreenCaptureKit device row are scoped `BLOCKED`. Milestone
  B and therefore this plan remain `BLOCKED` on the missing approved X native
  livestream-chat write contract. The aggregate `smoke:local-gates` command is
  also blocked by an out-of-scope, pre-existing Plan 027 smoke that still
  imports removed `sourceSelectionChangeMessages`; all later constituent gates
  were run directly and passed. See
  `docs/acceptance/2026-07-10-unified-livestream-comments.md`.

### Execution ledger

Treat each row as one independently reviewed executor handoff and one commit.
Do not give one agent the entire plan as an unbounded implementation task.

| Slice | Status | Depends on | Exit state |
|---|---|---|---|
| U0 | PASS | clean isolated worktree | stale gate repaired; lag frame, authoritative reconciliation, batching, and cleanup proven |
| U1 | PASS | U0 PASS | destination-scoped read/write truth, bindings, stable ids, and readiness migration proven |
| U2 | PASS | U1 PASS | correlated, persistent, concurrent fan-out and restart/idempotency behavior proven |
| U3 | BLOCKED | U1 PASS + owner-provided Google approval | production enablement and live proof await Google approval; explicit unavailable state proven |
| U4 | PASS | U1 PASS + shipped X read contract | automated receive/reconnect/timeouts pass; real account acceptance and Milestone B write remain separately blocked |
| U5 | PASS | U1 PASS | backend-authoritative highlight and stream/split artifact proof pass; real ScreenCaptureKit device step is scoped blocked |
| U6 | PASS | U2 and U5 PASS | correlated detached-window transport, sender validation, and live/history isolation pass |
| U7 | PASS | U6 PASS | shared Comments UI, keyboard behavior, and named dark/light/detached visual acceptance pass |
| U8 | PASS | U0-U2 and U4-U7 PASS; U3 PASS or scoped BLOCKED | focused account-free acceptance passes; real-provider/device rows and the unrelated stale aggregate-gate prerequisite are recorded separately as BLOCKED |

Milestone A may ship only after all non-external rows pass and every unavailable
provider is represented truthfully. Milestone B remains BLOCKED until X supplies
and Videorc proves an approved native-chat write contract.

### External prerequisites and ownership

The operator/owner, not an implementation agent, supplies:

- confirmation of Google OAuth app/scopes approval plus release-safe client
  configuration, without placing credentials in the repo;
- the revision or written outcome of X's private livestream-chat write contract;
- three provider accounts plus separate viewer accounts with the needed live,
  chat-read, and chat-write permissions for real acceptance;
- local macOS screen/camera/mic permissions required by the recording-studio
  artifact gates.

Missing Google material blocks only U3's enablement/live acceptance. Missing X
write material blocks only Milestone B. Missing real accounts or device
permissions marks the corresponding dated acceptance row `BLOCKED`; it does
not prevent mock, persistence, UI, relay, or compositor slices from proceeding.
Each acceptance row must contain a date, owner, and `PASS`, `FAIL`, or `BLOCKED`
reason. An executor must not contact providers or send external messages without
separate authorization.

## Why this matters

Videorc already has a merged Comments feed, persisted comments, a detached
window, YouTube/Twitch send fan-out, and a stream highlight overlay. Rebuilding
those surfaces would duplicate shipped work. The current implementation still
cannot meet the requested product contract: production YouTube chat is disabled
pending Google approval, X chat is read-only, outbound delivery and highlight
state can claim success before the provider/compositor confirms it, and the
maintained end-to-end smoke is stale.

This plan turns the existing feature into one authoritative domain with
per-destination read/write truth, correlated send operations, acknowledged
highlight state, explicit live/history modes, and real artifact/provider
acceptance. It also keeps the external boundary honest: an X Post/reply is not
an X livestream-chat message and must never be substituted silently.

## Product contract

### Milestone A — executable without a new X API

- One chronological Comments feed receives YouTube, Twitch, and native X
  comments when their documented credentials/context are available.
- The composer sends once to every **writable** active destination and shows a
  separate pending/sent/failed/read-only result for each. X is visibly
  "receive-only" until X documents a write flow.
- Clicking a live comment shows `Applying…`, then `On stream` only after the
  backend confirms the overlay is installed on a viewer-facing stream leg.
- Historical comments are a distinct mode: no composer, no highlight action,
  and live updates cannot overwrite the selected historical transcript.
- No provider, relay, or compositor failure is swallowed or represented as
  success.

### Milestone B — literal three-native-chat outbound fan-out

- Requires a documented, approved X livestream-chat write API for Videorc's
  allow-listed app.
- Implement the X sender only from that contract, with mock and live-account
  acceptance equivalent to YouTube/Twitch.
- If X does not provide it, keep Milestone A's receive-only X state and leave
  this plan BLOCKED. A separately approved "Post on X" feature may use the
  public Posts API, but it is outside this plan and must use different copy and
  delivery status.

## Current capability matrix

| Platform | Read comments now | Send now | Required work |
|---|---|---|---|
| YouTube | Connector exists, but production OAuth is hard-disabled; Manual RTMP is skipped | Sender exists but is unreachable for the same reason | Google approval, release-ready OAuth, and chat binding independent of RTMP auth mode |
| Twitch | EventSub WebSocket works for OAuth and Manual RTMP when a scoped account exists | Helix sender exists | Model write scope separately; parse `is_sent`/`drop_reason`; add deadlines and live acceptance |
| X | Native, allow-listed Livestream path is read-only; Manual RTMP lacks broadcast context | No documented sender | Harden reconnect/live proof; keep write state `read-only` unless X supplies a documented write contract |

Public references checked 2026-07-10:

- YouTube receive: <https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList>
- YouTube send: <https://developers.google.com/youtube/v3/live/docs/liveChatMessages/insert>
- YouTube installed-app OAuth: <https://developers.google.com/youtube/v3/guides/auth/installed-apps>
- Twitch chat authentication: <https://dev.twitch.tv/docs/chat/authenticating/>
- Twitch send/receive guide: <https://dev.twitch.tv/docs/chat/send-receive-messages/>
- Twitch send response contract: <https://dev.twitch.tv/docs/api/reference#send-chat-message>
- X's repo-specific private contract is summarized in
  `plans/028-x-livestream-api-integration.md:58-197`; it explicitly says chat
  is read-only at lines 164-197 and 753-754.
- The public X API indexes expose no native livestream-chat endpoint:
  <https://docs.x.com/x-api/llms.txt> and <https://docs.x.com/openapi.json>.

## Current state

### Shared backend model and persistence already exist

- `crates/videorc-backend/src/live_chat.rs:84-127` defines the normalized
  `LiveChatMessage` and `LiveChatSnapshot` used by every provider.
- `crates/videorc-backend/src/live_chat.rs:403-420` owns the bounded buffer,
  de-duplication, connector tasks, and session-scoped send credentials.
- `crates/videorc-backend/src/live_chat.rs:992-1009` persists every new inbound
  comment before emitting `liveChat.message`.
- `crates/videorc-backend/src/storage.rs:206-267` and
  `crates/videorc-backend/src/main.rs:3305-3318` expose saved session comments.

The current sender registry is too coarse:

```rust
// crates/videorc-backend/src/live_chat.rs:377-384
pub enum ChatSenderConfig {
    YouTube { /* token, base URL, liveChatId */ },
    Twitch(crate::twitch_chat::TwitchChatSenderConfig),
}
```

It is keyed by `StreamPlatform`, not destination/target id. Read and write
capability are conflated in one provider connection state plus free-form string
tags. It cannot truthfully represent connected/read-only X or readable Twitch
with a stale token missing `user:write:chat`.

Message app ids are currently `{platform}:{providerMessageId}`
(`live_chat.rs:129-133`), while SQLite uses that id alone as the primary key
(`storage.rs:220-240`). Include session and destination identity in new ids so
two sessions or same-platform targets cannot overwrite one another.

### Platform adapters are uneven

- YouTube's read and send implementations are real
  (`youtube_chat.rs:484-637`, `55-92`), but `oauth.rs:25-31` hard-disables
  production OAuth and `main.rs:1493-1506` skips Manual RTMP chat setup.
- YouTube broadcast-id resolution currently turns every network/auth failure
  into "No live chat" through `.ok().flatten()` at
  `youtube_chat.rs:534-554`. Preserve the actual failure classification.
- Twitch receives five EventSub chat event types and reconnects with bounded
  backoff (`twitch_chat.rs:38-45`, `556-708`). OAuth requests read and write
  scopes (`oauth.rs:749-763`), but startup validates read only
  (`main.rs:1436-1464`).
- Twitch's sender treats every 2xx as delivered and ignores the documented
  `data[].is_sent` and `drop_reason` response body
  (`twitch_chat.rs:67-102`). A provider-side drop can therefore be shown as
  sent.
- X is explicitly receive-only (`x_chat.rs:1-7`). It retries initial token
  availability but has no WebSocket reconnect loop or live integration proof
  (`x_chat.rs:108-208`, `359-410`).
- Fan-out is sequential and has no per-provider deadline
  (`live_chat.rs:877-943`). One slow provider delays every later destination.
  Never blindly retry a timed-out, non-idempotent send.

### The backend event stream can drop Comments permanently

The global broadcast channel has capacity 256 (`main.rs:178`). Each WebSocket
connection currently uses:

```rust
// crates/videorc-backend/src/main.rs:2420-2438
while let Ok(event) = events.recv().await {
    // send event
}
```

`RecvError::Lagged` exits this loop permanently. Match the existing robust
pattern at `main.rs:518-526`: continue on lag, stop only on closed, and force a
fresh `liveChat.status` snapshot after a detected lag so missed comment events
are reconciled.

### The detached window relay is fire-and-forget

- Comments input and click actions travel Comments renderer → main process →
  main renderer → backend; results travel back through a separate push
  (`apps/desktop/src/main/index.ts:8206-8247`,
  `apps/desktop/src/renderer/src/hooks/use-studio.tsx:1120-1159`).
- There is no request id or timeout. A late result can update the wrong pending
  UI state, and a missing/reloaded main renderer leaves the detached window
  pending without a terminal result.
- Main caches only one `latestCommentsSnapshot` (`main/index.ts:191-192`,
  `8196-8205`). Opening saved comments and then receiving a live push can replace
  the historical transcript.

Keep the existing single backend WebSocket in the main renderer for this plan;
do not broaden the work into an app-wide transport migration. Add a small,
typed main-process Comments command broker that correlates request/result ids,
times out, validates the sender window, and maintains separate live and history
snapshot caches.

### Highlight pixels exist, but highlight truth does not

- The dedicated highlight overlay and stream-leg routing are sound:
  `main.rs:2585-2613`, `captions.rs:282-302`, and
  `recording.rs:753-770`.
- The renderer sets its local selected id before PNG rendering/backend install;
  it then swallows `comments.highlight.set` failures
  (`use-studio.tsx:1120-1135`, `1171-1209`).
- The UI can display `On stream` while idle, record-only, or after a failed
  install. Historical rows are also clickable because eligibility checks only
  message type/deletion (`comments-reader.tsx:314-341`).
- The supported compositor path burns the overlay on stream output, but the
  explicitly legacy >30fps path bypasses the compositor bridge
  (`recording.rs:4299-4317`). Do not claim universal highlight support there.
  Either prove a viewer-facing dynamic overlay for that path or expose a clear
  `highlight-unavailable` reason. The currently named "Legacy Stream 1080p60"
  preset may remain explicitly unsupported; no silent success is allowed.

### Tests prove pieces, not the requested contract

Current focused baseline on 2026-07-10:

The checkout contained unrelated native-preview work, so the counts below are
evidence from that working tree, not exact count assertions for a clean
`90a7129b` checkout. Future gates require all tests to pass; they need not match
these totals.

- `pnpm --filter @videorc/desktop test`: PASS, 73 files / 574 tests under
  Node 24 arm64.
- `cargo test -p videorc-backend live_chat`: PASS, 17 focused tests.
- `cargo test -p videorc-backend x_chat`: PASS, 4 focused tests.
- `cargo test -p videorc-backend youtube_chat`: PASS, 14 focused tests.
- `cargo test -p videorc-backend twitch_chat`: PASS, 10 focused tests.
- `pnpm smoke:live-chat-fake-providers`: FAILS at
  `scripts/smoke-live-chat-fake-providers.mjs:24-40` because it still expects X
  to be unsupported even though native X read support is enabled.

The smoke starts only one fake provider, accepts a 1×1 highlight PNG without
inspecting stream pixels, and is omitted from `smoke:local-gates`
(`package.json:123`, `132`). Its launcher logging must also redact ephemeral
backend authentication material before output is retained as evidence.

### UI conventions to preserve

- This is a Vite/Electron React app with shadcn/radix components, Tailwind v4,
  Phosphor icons, and aliases from `apps/desktop/components.json`.
- Read `.agents/skills/videorc-design/SKILL.md` and
  `.agents/skills/shadcn/SKILL.md` before the UI slice.
- Use existing shadcn `ScrollArea`, `InputGroup`, `Badge`, `Button`, `Kbd`,
  `Separator`, and `Empty`. Add shadcn `Avatar` through the CLI (preview with
  `--dry-run`/`--diff`) instead of extending the custom avatar widget.
- Match the black-glass tokens in `styles.css`; do not restyle tokens or other
  screens. Platform glyphs and tiny semantic status dots are the only saturated
  color.
- Share one comment-row composition between the Studio rail and detached
  window. Full-row selection uses the existing accent fill; rings are
  focus-visible only.

## Commands you will need

This machine's default `/usr/local/bin/node` is an obsolete x64 Node 19. Use
the repo-required Node 24 runtime for every pnpm command:

| Purpose | Command | Expected on success |
|---|---|---|
| Runtime | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" node -p 'process.version + " " + process.arch'` | Node 24+, `arm64` |
| Desktop tests | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm --filter @videorc/desktop test` | all tests pass |
| Typecheck | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm typecheck` | exit 0, no errors |
| Lint | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm lint` | exit 0 |
| Format check | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm format:check` | exit 0 |
| Rust focused | `cargo test -p videorc-backend live_chat` | all focused tests pass |
| Provider tests | `cargo test -p videorc-backend youtube_chat && cargo test -p videorc-backend twitch_chat && cargo test -p videorc-backend x_chat` | all focused tests pass |
| Rust full | `cargo fmt --check --all && cargo test -p videorc-backend && cargo clippy -p videorc-backend -- -D warnings` | exit 0; all tests pass |
| Fake-provider E2E | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:live-chat-fake-providers` | PASS for simultaneous YT/Twitch/X reads, delivery matrix, reconnect/snapshot recovery, and highlight ack |
| Comments window | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm probe:comments-window` | PASS for live/history modes and acknowledged send/highlight actions |
| Highlight artifact | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:comment-highlight-stream` | ffmpeg/ffprobe proves the selected card and captions coexist on each supported stream leg |
| UI screenshots | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" node scripts/ui-theme-screens.mjs studio streaming` | seeded dark/light Comments rail screenshots written under `/tmp` |
| Script tests | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm test:scripts` | all pass |
| Desktop build | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm build` | exit 0 |
| Recording studio | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:recording-studio` | full maintained gate passes |
| Final local gate | `PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:local-gates` | exit 0 and now includes the live-chat smoke |

## Scope

**In scope** (the only existing product files this plan may modify):

- Backend domain/provider/storage:
  - `crates/videorc-backend/src/live_chat.rs`
  - `crates/videorc-backend/src/youtube.rs`
  - `crates/videorc-backend/src/youtube_chat.rs`
  - `crates/videorc-backend/src/twitch_chat.rs`
  - `crates/videorc-backend/src/x_chat.rs`
  - `crates/videorc-backend/src/oauth.rs`
  - `crates/videorc-backend/src/preflight.rs`
  - `crates/videorc-backend/src/storage.rs`
  - `crates/videorc-backend/src/main.rs`
  - `crates/videorc-backend/src/state.rs`
  - `crates/videorc-backend/src/captions.rs`
  - `crates/videorc-backend/src/compositor.rs`
  - `crates/videorc-backend/src/recording.rs`
  - one new focused Rust module if needed, preferably
    `crates/videorc-backend/src/comment_highlight.rs`
- Desktop protocol/relay/state:
  - `apps/desktop/src/shared/backend.ts`
  - `apps/desktop/src/main/index.ts`
  - `apps/desktop/src/preload/index.ts`
  - new `apps/desktop/src/shared/comments-send-operation.ts`
  - new `apps/desktop/src/shared/comments-send-operation.test.ts`
  - new `apps/desktop/src/main/comments-command-broker.ts`
  - new `apps/desktop/src/main/comments-command-broker.test.ts`
  - `apps/desktop/src/renderer/comments/main.tsx`
  - `apps/desktop/src/renderer/src/hooks/use-studio.tsx`
- Comments UI only:
  - `apps/desktop/src/renderer/src/components/comments-reader.tsx`
  - `apps/desktop/src/renderer/src/components/live-chat-panel.tsx`
  - `apps/desktop/src/renderer/src/components/live-chat-rail.tsx`
  - `apps/desktop/src/renderer/src/components/chat-platform-icon.tsx`
  - `apps/desktop/src/renderer/src/components/go-live-dialog.tsx` + focused test
  - `apps/desktop/src/renderer/src/components/tabs/library-tab.tsx`
  - `apps/desktop/src/renderer/src/components/tabs/studio-tab.tsx`
  - new shared `comment-row.tsx`, `comment-row.test.tsx`,
    `comments-destination-status.tsx`, and focused test
  - `apps/desktop/src/renderer/src/components/ui/avatar.tsx` (generated through
    shadcn CLI if absent)
  - `apps/desktop/src/renderer/src/lib/chat-send.ts` + tests
  - `apps/desktop/src/renderer/src/lib/comment-highlight.ts` + tests
  - `apps/desktop/src/renderer/src/lib/live-chat-view.ts` + tests
  - `apps/desktop/src/renderer/src/lib/caption-overlay.ts` + focused tests
- YouTube chat binding UI only if Google approval is confirmed:
  - `apps/desktop/src/renderer/src/components/tabs/streaming-tab.tsx`
  - `apps/desktop/src/renderer/src/lib/capture.ts` + focused tests
  - existing `youtube-*` broadcast/channel helpers and their focused tests;
    create a new helper only if no existing one owns broadcast selection
- Gates/docs:
  - `scripts/smoke-live-chat-fake-providers.mjs`
  - `scripts/smoke-oauth-guards-app.mjs`
  - `scripts/comments-window-probe.mjs`
  - `scripts/ui-theme-screens.mjs`
  - new `scripts/smoke-comment-highlight-stream-app.mjs`
  - new `scripts/lib/comment-highlight-artifact.mjs`
  - new `scripts/lib/comment-highlight-artifact.test.mjs`
  - `scripts/lib/recording-studio-gates.mjs`
  - `scripts/lib/recording-studio-gates.test.mjs`
  - other focused helpers/tests under `scripts/lib/` only when named in a slice
  - `package.json`
  - `docs/live-chat-live-smoke-checklist.md`
  - `docs/oauth-live-smoke.md`
  - `docs/acceptance/2026-07-05-comments-window-upgrade.md`
  - new `docs/acceptance/2026-07-10-unified-livestream-comments.md`
  - this plan and `plans/README.md`

**Out of scope** (do NOT touch):

- Reverse-engineering an X WebSocket send frame, automating x.com, or calling an
  X Post/reply "live chat".
- The X broadcast/source lifecycle in `x_live.rs`, except a narrowly documented
  credential handoff if X supplies an approved chat-write endpoint.
- General recording, encoder, native preview, scene/layout, or FFmpeg refactors.
  Focused highlight capability/leg changes in the three listed Rust media files
  are allowed. If universal >30fps dynamic overlay requires broader work,
  report it as a separate media dependency; first land truthful capability
  gating.
- Comment moderation, bans, polls, reactions, or platform-side deletion.
- Changing entitlement/pricing boundaries.
- Restyling global design tokens or unrelated screens.
- Reverting, staging, or folding in the existing native-preview worktree edits.

## Git workflow

- The checkout was already dirty with unrelated native-preview work when this
  plan was written. Start from a clean branch/worktree after that work is
  committed, or use an isolated worktree. Never reset or stage those edits.
- Branch: `codex/033-unified-livestream-comments`
- Commit one verified slice at a time, matching existing messages such as
  `Comments upgrade S5: write once, reach every chat`. Suggested prefix:
  `Comments unification U0: ...` through `U8: ...`.
- Do not push or open a PR unless the operator explicitly requests it.

## Target domain shape

Use names equivalent to these; exact Rust/TS syntax may follow local style:

```ts
type CommentsDestinationState = {
  id: string // stream target id, never platform alone
  platform: 'youtube' | 'twitch' | 'x'
  read: 'connecting' | 'ready' | 'ended' | 'failed' | 'unavailable'
  write: 'ready' | 'missing-scope' | 'read-only' | 'failed' | 'unavailable'
  message?: string
}

type CommentsSendOperation = {
  id: string
  sessionId: string
  text: string
  phase: 'sending' | 'sent' | 'partial' | 'failed' | 'delivery-unknown'
  destinations: Record<string, {
    phase:
      | 'pending'
      | 'sent'
      | 'failed'
      | 'read-only'
      | 'unavailable'
      | 'timed-out-unknown'
    providerMessageId?: string
    reason?: string
  }>
}

type CommentHighlightState = {
  sessionId?: string
  messageId?: string
  generation: number
  phase: 'idle' | 'live' | 'failed'
  expiresAt?: string
  reason?: string
}

type CommentsViewMode =
  | { kind: 'live' }
  | { kind: 'history'; sessionId: string; title: string }
```

The backend owns destination, send-operation, and installed-highlight truth.
The main process owns only cross-window command correlation and which snapshot
the detached window is viewing. Renderers own transient visual state such as
`Applying…` while a PNG is being produced.

`timed-out-unknown` means the provider may have accepted the message even
though Videorc did not receive a conclusive response. Persist it as unknown,
never collapse it to failed, and never auto-retry it. Repeating an existing
operation id returns the stored operation without any provider call.

## Steps

### U0: Pin current truth and repair the broken gate

1. Update `scripts/smoke-live-chat-fake-providers.mjs` so a profile with no X
   account expects X capability `not-connected`, `chatReadAvailable: false`,
   while `liveChat.xCommentsReadiness.available` reflects the shipped private
   read path.
2. Update `docs/live-chat-live-smoke-checklist.md` and the stale read-only /
   ephemeral comments in `apps/desktop/src/shared/backend.ts`, `use-studio.tsx`,
   and `live-chat-view.ts` to match SQLite persistence, X read support, and
   YouTube's current approval pause.
3. Make the backend WebSocket event relay continue on `RecvError::Lagged`. The
   affected socket must write a typed, per-socket
   `events.lagged { skipped, occurredAt }` frame directly to its client — do
   not publish that recovery frame back through the same lossy broadcast
   channel — and then resume receiving. Mirror the event in shared TS. On that
   signal or a reconnect, `use-studio` requests `liveChat.status` and replaces
   incremental belief with the authoritative snapshot. Add a focused
   WebSocket integration test with a deliberately tiny broadcast buffer that
   proves the lag frame is delivered, the relay stays open, and the snapshot
   converges.
4. Redact ephemeral backend auth material from fake-smoke console output.
5. Batch renderer comment events over one short frame/microtask window and feed
   them through the existing `applyLiveChatMessages` reducer instead of one
   React state update per message. A burst must remain chronological and
   de-duplicated, then reconcile from the full snapshot after any lag signal.
6. Add `smoke:live-chat-fake-providers` to `smoke:local-gates` only after it is
   green and cleanup is proven.

**Verify**:

```sh
cargo test -p videorc-backend live_chat
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm test:scripts
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:live-chat-fake-providers
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm typecheck
```

Expected: all pass; X read availability is asserted without claiming X write;
lag recovery ends with a reconciled full snapshot; no auth token appears in
retained smoke output.

### U1: Replace platform-level readiness with per-destination read/write truth

1. Add typed `read` and `write` capability fields keyed by target id. Preserve
   the existing wire fields temporarily so U1 can land without breaking the
   renderer, then migrate all callers and remove the string capability tags in
   U6.
2. Build session chat bindings from enabled stream targets, their auth mode,
   account, and provider broadcast context — not only a list of platforms.
3. Represent late native X attachment as `waiting-for-broadcast-context`, then
   replace that destination row when publish returns `broadcastId`/`mediaKey`.
4. For Twitch, check both `user:read:chat` and `user:write:chat` before the
   session. A stale account may read while write reports `missing-scope`.
5. Expose separate read/write readiness in Go Live preflight. Chat problems stay
   warnings and never stop video unless the stream target itself is invalid.
6. Turn connector-preparation failures into the affected destination's typed
   read/write state; do not leave the exact error only in backend logs.
7. Include `sessionId` and `targetId` in normalized app message ids. Keep
   provider ids separately for provider operations and same-session de-dup.

**Verify**:

```sh
cargo test -p videorc-backend live_chat
cargo test -p videorc-backend preflight
cargo test -p videorc-backend storage
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm --filter @videorc/desktop test
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm typecheck
```

Expected: matrices cover OAuth/manual RTMP × YouTube/Twitch/X; duplicate
provider ids in two sessions/targets persist as two rows; legacy TS callers
still compile until U6 switches them.

### U2: Make outbound fan-out concurrent, correlated, persistent, and honest

1. Change `liveChat.send` to require a UUID-like `operationId`, `sessionId`, and
   text. Reject a stale/wrong session before calling any provider. Retain the
   shared 200-character cap because YouTube is the narrowest supported
   destination. Treat `operationId` as an idempotency key: persist the pending
   row before provider calls, and return the stored operation without resending
   if the same id arrives again.
2. Snapshot writable destination adapters under the coordinator lock, release
   the lock, and execute them concurrently with a bounded per-provider deadline.
   Return one result per active destination, including `read-only` X and
   `missing-scope` Twitch. A deadline without a conclusive provider response is
   `timed-out-unknown`, not `failed`; aggregate it as `delivery-unknown` or
   `partial` when another destination has a conclusive result.
3. Never auto-retry an ambiguous timed-out POST. Let an operator retry only the
   failed/unknown destination through a future explicit action; never resend to
   already successful destinations.
4. Parse YouTube's successful response id and provider error reason. Preserve
   disabled/ended/rate-limit/auth distinctions instead of flattening them.
5. Parse Twitch's 2xx body. `is_sent: false` is a failure and must surface its
   `drop_reason`; capture `message_id` when sent. Respect rate-limit headers in
   the reported retry guidance.
6. Persist one outbound operation and its per-destination results under the
   session using a new focused SQLite table (or an equally explicit migration).
   Do not represent a local echo as a fake `custom` platform message.
7. Emit operation updates so reconnecting renderers can query and reconcile
   pending/sent/partial/failed/delivery-unknown state without duplicates.
8. On backend startup/recovery, find persisted operations left `pending` by a
   prior process. Without calling any provider, convert each orphaned pending
   destination to `timed-out-unknown` with an `interrupted-before-confirmation`
   reason, recompute the aggregate, persist it, and emit/query that terminal
   state. A still-running in-memory operation is not orphaned. Repeating its
   operation id after restart returns the recovered state and never resends.

**Verify**:

```sh
cargo test -p videorc-backend live_chat
cargo test -p videorc-backend youtube_chat
cargo test -p videorc-backend twitch_chat
cargo test -p videorc-backend storage
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm typecheck
```

Expected: mock tests cover all success, partial, auth, rate-limit, dropped-2xx,
timeout, and wrong-session cases. A deliberately slow provider does not delay a
fast provider beyond its own deadline. Restart/query returns the same operation
state. Repeating an operation id returns that stored state and makes zero new
provider calls. A simulated crash after persisting `pending` recovers as
`timed-out-unknown` and cannot remain pending indefinitely.

### U3: Restore YouTube comments only behind verified production OAuth

This slice has an external precondition: Google has approved the active Videorc
OAuth app/scopes and the release credential/callback configuration is ready.

1. Record that approval without secrets in the dated acceptance note and
   provider-readiness evidence. If approval is not confirmed, leave YouTube
   read/write `unavailable` with the current message and skip the code-enabling
   portion of this slice.
2. Replace the unconditional hard-disable with a release-validated provider
   capability. Request the narrow `youtube.force-ssl` scope, system-browser
   OAuth, loopback callback, offline access, and secure refresh-token storage.
3. Decouple chat identity from stream transport as Twitch already does. An
   OAuth YouTube stream uses its prepared broadcast id. A Manual RTMP YouTube
   stream may attach comments only when the user has connected YouTube and
   explicitly selected the matching broadcast; never guess among multiple live
   broadcasts.
4. Preserve real ID-resolution/auth/network errors in provider state. Chat
   failure degrades Comments only; video keeps streaming.
5. Add provider-ready and manual-RTMP matrices plus a real account smoke.

**Verify**:

```sh
cargo test -p videorc-backend youtube_chat
cargo test -p videorc-backend oauth
cargo test -p videorc-backend live_chat
cargo test -p videorc-backend preflight
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:oauth
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:oauth-guards
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:provider-readiness:strict
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm typecheck
```

Expected: pre-approval builds remain explicitly unavailable; approved builds
can connect, refresh, resolve the selected broadcast, receive, and send without
exposing credentials.

### U4: Harden native X receive and preserve the write boundary

1. Add a mock integration test for chat-token fetch → `accessChatPublic` →
   WebSocket auth/subscribe → normalized delivery.
2. Add bounded reconnect/backoff after socket loss, refresh chat access as
   required, and make wrong-session late attachment fail explicitly. Confirm
   connection-ready semantics from the private contract/live evidence: use a
   documented acknowledgement when one exists; otherwise define and test a
   bounded authenticated/subscribed grace state. Do not report `connected`
   immediately after merely writing frames without evidence.
3. Keep `write: read-only` in the destination model. The composer must display
   this state rather than omit X or hide an unsupported result.
4. Ask the operator/owner to obtain written confirmation from the X partner
   contact about an approved native-chat write flow. The executor must not send
   an external message without separate authorization. Once the owner supplies
   it, record only the outcome/contract revision, never private credentials or
   API secrets.
5. If X supplies a documented write path, add `ChatSenderConfig::X` in a
   separate commit with mock, rate-limit/error, and live acceptance. Otherwise
   stop Milestone B here; do not invent a socket frame.

**Verify**:

```sh
cargo test -p videorc-backend x_chat
cargo test -p videorc-backend live_chat
```

Expected: reconnect and wrong-session tests pass. X is always present in the
delivery matrix as sent/failed only when a documented sender exists; otherwise
it is explicitly receive-only.

### U5: Make highlight state backend-authoritative and stream-path truthful

1. Add a backend `CommentHighlightState` with session id, message id,
   generation, phase, expiry, and reason. Add `status`, `set`, and `clear`
   commands/events mirrored in shared TS.
2. `set` accepts `{sessionId, messageId, pngBase64, position}`. The backend owns
   the 10-second TTL (or clamps a future optional TTL to a documented range);
   renderers cannot choose an arbitrary lifetime. Validate the active recording
   status is actually `streaming`, the message belongs to that active
   session/destination, it is not deleted/system-only, and the active output
   path has a viewer-facing highlight overlay.
3. Install the PNG first, then publish `live`. The backend owns the 10-second
   expiry with a generation guard so an old timer cannot remove a newer card.
   Session start/stop clears both overlay and state authoritatively.
4. The renderer may show `Applying…` while rasterizing, but it shows `On stream`
   only after the backend response/event. Surface rendering/install errors and
   roll back applying state.
5. Add the platform glyph/name to the rendered card while keeping the existing
   black-glass recipe and caption coexistence.
6. For the legacy >30fps path, either add and artifact-test a dynamic
   viewer-facing overlay or return `highlight-unavailable` before installation.
   Never return success when no stream leg consumes the slot.
7. In this slice, add `scripts/smoke-comment-highlight-stream-app.mjs` and the
   deterministic analyzer/test in
   `scripts/lib/comment-highlight-artifact.{mjs,test.mjs}`. Select a fake
   comment, wait for backend `live`, record/stream the maintained motion
   stimulus, and prove with ffmpeg/ffprobe that the full card and captions
   coexist on stream-only and split record+stream output. The legacy path must
   produce visible pixels or an explicit unavailable result. Register
   `smoke:comment-highlight-stream` in `package.json` and in
   `scripts/lib/recording-studio-gates.mjs`; update its test so
   `smoke:recording-studio` cannot omit this proof.

**Verify**:

```sh
cargo test -p videorc-backend comment_highlight
cargo test -p videorc-backend captions
cargo test -p videorc-backend compositor
cargo test -p videorc-backend recording
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm --filter @videorc/desktop test
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm typecheck
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm test:scripts
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:comment-highlight-stream
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:recording-studio
```

Expected: applying/live/failed and stale-generation cases pass; history,
idle, record-only, wrong-session, deleted/system, and unsupported output paths
are rejected; caption and highlight pixels coexist in the finished output
artifacts. U5 is not handed off until the maintained recording-studio gate
passes.

### U6: Correlate detached-window commands and separate live/history modes

1. Add a pure main-process Comments command broker. Every send/highlight/clear
   action carries a request id; the broker waits for a matching result, rejects
   stale/duplicate results, and returns a terminal timeout/unavailable error if
   the main renderer/backend is missing.
2. Relay highlight requests as `{sessionId, messageId}`, not an arbitrary full
   message object. The main renderer resolves it from the active snapshot before
   rasterizing; backend U5 validation remains the final authority.
3. Maintain separate `latestLiveCommentsSnapshot` and history snapshots keyed
   by session. `CommentsViewMode` controls what the detached window displays.
   Live pushes update the live cache but never replace a selected history view.
4. History mode shows session title/date and a `Back to live` action. It has no
   composer or highlight callback. Live mode restores the current live snapshot
   and destination status.
5. Replace the uncorrelated optimistic echo with U2's send-operation row. Late
   results update only their own operation id.
6. Finish U1's wire migration: switch every renderer, preflight, smoke, and
   fixture to the typed destination `read`/`write` fields, then remove only the
   legacy `LiveChatProviderState.capabilities: Vec<String>` /
   `capabilities: string[]` compatibility field and `capability_state_tag`
   helpers. Do not touch unrelated entitlement capability types.

**Verify**:

```sh
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm --filter @videorc/desktop test
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm probe:comments-window
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm typecheck
! rg -n 'pub capabilities: Vec<String>|capabilities: string\[\]|capability_state_tag' \
  crates/videorc-backend/src/live_chat.rs apps/desktop/src/shared/backend.ts
```

Expected: broker tests cover missing renderer/backend, timeout, duplicate/late
result, sender validation, and live/history cache isolation. The probe proves
history remains pinned while live messages arrive.
The final grep prints no legacy provider-capability matches.

### U7: Unify the two Comments surfaces in Videorc's design language

1. Rename remaining user-facing "Live chat" labels to "Comments" while keeping
   provider API symbols as chat where appropriate.
2. Extract one shared `CommentRow` for rail and window: shadcn `Avatar` with
   fallback, platform glyph, author, text, time, optional paid status, and
   applying/live/failed highlight state. The detached variant may use larger
   type, but behavior and accessibility stay shared.
3. Replace the composer with `InputGroup` + addon action, visible `↵` `Kbd`, and
   a destination strip that says exactly, for example,
   `Sends to YouTube + Twitch · X receive-only`. Never hide read-only/failed
   destinations after a partial success.
4. Use shadcn `ScrollArea`, `Separator`, `Empty`, `Badge`, and `Button`; keep one
   glass surface rather than a bordered card inside a bordered rail. Use
   semantic status dots, full-row accent selection, and focus-visible rings
   only.
5. Rename `Clear` to `Clear view` and explain that saved Library history is not
   deleted.
6. Make visual QA reproducible. Extend `ui-theme-screens.mjs` with a seeded
   three-provider live snapshot and capture the Studio Comments rail in dark
   and light themes at the maintained main-window size. Extend
   `comments-window-probe.mjs` with a `comments-window-capture-page` smoke
   command and save 420×640 detached-window PNGs for: live/idle, one applying
   highlight, partial send with X receive-only, and history mode without a
   composer. Store paths and a by-eye result in the dated acceptance note;
   generated PNGs remain under `/tmp`, not in git.

Before adding Avatar, run the shadcn CLI from `apps/desktop` with the repo's
pnpm/Node 24 runtime: inspect docs, preview with `--dry-run`/`--diff`, then add.
Read the documentation URL returned by `docs`. Do not overwrite existing
components.

```sh
cd apps/desktop
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm dlx shadcn@latest docs avatar
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm dlx shadcn@latest add avatar --dry-run
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm dlx shadcn@latest add avatar --diff avatar.tsx
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm dlx shadcn@latest add avatar
cd ../..
```

**Verify**:

```sh
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm --filter @videorc/desktop test
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm typecheck
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm lint
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm format:check
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" node scripts/ui-theme-screens.mjs studio streaming
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm probe:comments-window
```

Expected: all pass; both surfaces share row behavior; keyboard-only operation
works; dark and light main-app surfaces plus the dark detached window match the
existing token system. The acceptance note records legible author/message
hierarchy, no clipped destination status at 420 px, visible focus/selection,
and an unambiguous live-versus-history mode for every named screenshot.

### U8: Prove the real outcome, not only state changes

1. Extend the fake-provider harness to run simultaneous fake YouTube, Twitch,
   and X readers, out-of-order messages, duplicate ids, a reconnect/lag, and
   fake senders with sent/failed/read-only/timeout outcomes.
2. Extend `comments-window-probe.mjs` to exercise correlated send, acknowledged
   highlight, failed highlight, and history mode. Do not stop at DOM presence.
3. Re-run U5's `smoke:comment-highlight-stream` against the integrated U6/U7
   UI flow: select the comment through the actual detached-window IPC, wait for
   backend `live`, and retain ffmpeg/ffprobe evidence that the full card and
   captions remain visible on stream-only and split record+stream output. The
   legacy path must still show pixels or explicit unavailable status. Extend
   the existing analyzer only if integration exposes a missing assertion; do
   not create a second artifact harness.
4. Run the real-provider checklist with separate viewer accounts:
   - each platform posts a unique marker; all three appear in one feed;
   - one app send reaches every writable platform with provider-confirmed ids;
   - X shows receive-only unless the approved write contract exists;
   - clicking one comment from each platform produces the same viewer-facing
     highlight on every outgoing stream;
   - disconnect/reconnect and session stop recover/clear correctly.
5. Update the July 5 acceptance note and create
   `docs/acceptance/2026-07-10-unified-livestream-comments.md` with redacted,
   per-provider `PASS`/`FAIL`/`BLOCKED` evidence. Do not mark owner sign-off
   complete from mock tests.
6. Run the full recording-studio and local gates.

**Verify**:

```sh
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:live-chat-fake-providers
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm probe:comments-window
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:comment-highlight-stream
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm test:scripts
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:recording-studio
PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH" pnpm smoke:local-gates
```

Expected: all automated gates pass and the dated real-provider acceptance has
PASS/FAIL/BLOCKED per destination. Milestone B remains BLOCKED unless X native
chat send has a documented contract and live proof.

## Test plan

### Rust

- `live_chat.rs`:
  - per-target read/write capability matrices;
  - same provider id across sessions/targets remains distinct;
  - concurrent fan-out and slow-provider isolation;
  - wrong-session rejection;
  - sent/partial/failed/read-only operation aggregation;
  - no automatic retry after ambiguous timeout;
  - repeated operation id returns the original stored result without resending;
  - session-scoped credentials and persisted operation recovery.
- `youtube_chat.rs`:
  - successful insert parses provider id;
  - disabled/ended/rate-limit/auth/network errors stay distinct;
  - broadcast resolution preserves the real error;
  - streamList reconnect resumes from token.
- `twitch_chat.rs`:
  - write scope missing while read is ready;
  - 2xx `is_sent: false` + `drop_reason` is failure;
  - success captures `message_id`;
  - 401/403/429 and rate headers;
  - EventSub reconnect continuity.
- `x_chat.rs`:
  - complete mocked token/access/socket flow;
  - ack, reconnect/backoff, and wrong-session cases;
  - read-only write state unless a documented sender is added.
- highlight module:
  - applying/install/live/expire/clear generations;
  - start/stop clearing;
  - active-stream/session/message validation;
  - viewer-leg capability for every supported/legacy output path.
- `storage.rs`: migrations and round trips for destination identity and outbound
  operations, including existing databases.
- WebSocket relay: lag continues and refreshes snapshot; closed terminates.

### TypeScript/Electron

- `chat-send.test.ts`: visible all-destination matrix, late result isolation,
  backend unavailable, partial success, Twitch missing scope, X receive-only,
  persisted operation rehydrate, no fake custom-platform echo.
- `live-chat-view.test.ts`: burst batching stays chronological/de-duplicated and
  a lag signal replaces incremental belief with the authoritative snapshot.
- `comment-highlight.test.ts`: applying → live/failed, stale ack/expiry ignored,
  wrong session/history/idle/record-only rejected.
- broker tests: request correlation, timeout, sender validation, missing window,
  duplicate result, cache isolation.
- view tests: live/history mode, Back to live, clear-view copy, destination
  status ordering, shared CommentRow keyboard behavior.
- `caption-overlay.test.ts`: platform identity and three-line layout at supported
  stream widths.

### End-to-end

- Simultaneous three-provider fake feed and delivery matrix.
- Detached window send/highlight/history behavior through the actual IPC path.
- Final stream artifact pixel proof, not only overlay-slot state.
- Real YouTube/Twitch/native-X inbound; real YouTube/Twitch outbound; real X
  outbound only if a documented approved API exists.

## Done criteria

### Milestone A implementation complete

- [x] `pnpm --filter @videorc/desktop test` passes.
- [x] `cargo fmt --check --all`, full backend tests, and clippy pass.
- [x] `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` pass.
- [x] `pnpm test:scripts` passes.
- [x] `pnpm smoke:live-chat-fake-providers` passes and is included in
      `smoke:local-gates`.
- [x] `pnpm probe:comments-window` passes live/history and correlated action
      cases.
- [ ] `pnpm smoke:comment-highlight-stream` and
      `pnpm smoke:recording-studio` pass with final-artifact highlight evidence.
      The focused highlight smoke and recording-studio steps 1–18 pass; the
      combined item remains unchecked because step 19 had no ScreenCaptureKit
      source in the isolated worktree process.
- [x] The named main-rail and detached-window screenshots pass the U7 visual
      checklist and are referenced from the dated acceptance record.
- [x] Every active target exposes typed read and write state; one send operation
      shows a terminal provider-confirmed or `timed-out-unknown` result for every
      target, with no false sent state, silent omission, or indefinite pending.
- [x] A clicked live comment shows `On stream` only after backend acknowledgement
      and is visible in the outgoing artifact/player; history and unsupported
      output paths cannot claim success.
- [x] `git status --short` in the isolated implementation worktree shows no
      unrelated changes, and `plans/README.md` records the actual plan status.

### Milestone A real-provider acceptance

- [ ] The unified feed receives unique real comments from YouTube, Twitch, and
      native X in one session, with reconnect recovery.
- [ ] A real YouTube/Twitch send operation records provider message ids; X is
      visibly receive-only unless an approved native-chat writer exists.
- [ ] A real comment from each provider is highlighted and visibly equivalent
      on the outgoing player/artifact.
- [x] The dated acceptance record has an owner and `PASS`, `FAIL`, or `BLOCKED`
      for YouTube read/write, Twitch read/write, X read/write, reconnect, and
      highlight proof. Google/account/permission gaps are `BLOCKED`, never
      generic sign-off or inferred success.

### Milestone B literal requirement complete

- [ ] X has supplied a documented, approved native livestream-chat write
      contract for Videorc's app, implemented with mock/error/rate-limit tests.
- [ ] The same user-initiated operation is delivered to YouTube, Twitch, and X
      **native live chat**, with provider-confirmed ids and live viewer proof.

If Milestone A's internal criteria pass but an external acceptance row is
blocked, record that row and keep the plan `BLOCKED`. If X still has no native
write API, Milestone B and therefore the user's unchanged literal requirement
remain `BLOCKED`; do not redefine success as an X Post.

## STOP conditions

These are **scoped block outcomes**, not reasons to halt independent slices:

- Google approval cannot be confirmed: record U3/YouTube real acceptance
  `BLOCKED`, preserve explicit unavailable state, and continue non-U3 work.
- X supplies no write contract: record Milestone B/X write `BLOCKED`, preserve
  receive-only state, and continue Milestone A work.
- A provider account or local device permission is unavailable: record only
  that real acceptance row `BLOCKED` and continue mock/automated work.

Stop the affected implementation slice and report back — do not improvise — if:

- An implementation proposes reverse-engineering X frames, automating x.com, or
  relabeling a Post/reply as live chat.
- In-scope files contain uncommitted work from another slice that cannot be
  cleanly separated. Never reset or overwrite it.
- Backend/provider tests require printing OAuth tokens, refresh tokens, stream
  keys, chat tokens, or Authorization headers.
- Universal highlight support requires a broad encoder/preview refactor rather
  than a focused overlay path. Land truthful capability gating, then report the
  media dependency instead of widening this plan silently.
- Any send implementation needs blind retries of a request whose provider
  delivery is unknown.
- A step's focused verification fails twice after one reasonable correction.
- Real-provider behavior contradicts the cited official/private contract.

## Maintenance notes

- Provider APIs are not static. Recheck the official YouTube/Twitch docs and
  the revision of X's private partner contract before changing capabilities.
- Read and write capability must remain separate. A new provider should add one
  target adapter and matrix rows, not platform-specific conditionals in the UI.
- Outbound fan-out is never atomic. Reviewers should scrutinize partial success,
  timeouts, idempotency, and whether already-sent destinations can be duplicated.
- A provider echo and a local outbound operation are different records. Reconcile
  them through provider message ids; do not reintroduce fake `custom` echoes.
- Historical view selection is per-window UI state; live destination/send/highlight
  truth is backend state. Keep that ownership boundary explicit.
- If the legacy 60fps preset becomes a first-class production path, it must gain
  dynamic highlight artifact proof before the UI enables click-to-highlight.
- Keep captions and comment highlights in separate compositor slots. Captions
  remain bottom; comments remain top; coexistence stays in the recording-studio
  gate.
