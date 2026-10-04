# Orcle voice commands: contract (plan 140)

These are the binding shapes for plan 140's slices, which several agents build
in parallel. Parts D and E cross the web ↔ desktop line; identical copies
live in both repos at `docs/orcle-commands-contract.md`. Parts A–C are
desktop-internal, but every slice builds against them.

All new serialized optional fields use
`#[serde(default, skip_serializing_if = …)]` in Rust and `optionalSchema` in
`backend-rpc-contract.ts`. Code, wire and storage names keep `cohost`;
user-facing copy says "Orcle".

## A. Chat moderation (desktop, S4)

Moderation is a chat feature. Manual removal is free; voice-sourced removal is
Premium (Orcle).

### Rust API (`live_chat_moderation.rs`), used by S3

```rust
pub enum ModerationSource { Manual, OrcleVoice }          // wire: "manual" | "orcle-voice"
pub enum RemoveConfirmMode { Confirm, Countdown }         // wire: "confirm" | "countdown"
pub struct ModerationRequest {
    pub operation_id: String,      // UUID v4, minted by the caller (idempotency key)
    pub message_id: String,        // the app message id from live_chat_messages.id
    pub source: ModerationSource,
    pub reason: Option<String>,    // "toxic", "spam"… (≤ 40 chars, audit only)
    pub confirm_mode: RemoveConfirmMode, // ignored for Manual (runs at once)
}
pub async fn request(state: &AppState, req: ModerationRequest) -> Result<ModerationOperation, ModerationRefusal>;
pub async fn confirm(state: &AppState, operation_id: &str) -> Result<ModerationOperation, ModerationRefusal>;
pub async fn cancel(state: &AppState, operation_id: &str) -> Result<ModerationOperation, ModerationRefusal>;
pub struct ModerationRefusal { pub code: &'static str, pub message: String }
```

**Refusal codes:** `not-found`, `not-eligible` (owner message, tombstone,
notification row), `premium-required` (OrcleVoice only), `disabled` (kill
switch), `rate-limited` (more than 10 a minute), `already-pending`,
`not-pending`, `invalid-params`.

### RPCs (DurableChat lane, registered in the execution policy)

| RPC | Params | Returns |
| --- | --- | --- |
| `liveChat.moderation.request` | `{operationId, messageId, source, reason?, confirmMode?}` | `ModerationOperation` |
| `liveChat.moderation.confirm` | `{operationId}` | `ModerationOperation` |
| `liveChat.moderation.cancel` | `{operationId}` | `ModerationOperation` |
| `liveChat.moderationOperations.list` | `{sessionId}` | `ModerationOperation[]`, newest first, at most 200 |

The event `liveChat.moderationOperation` carries a `ModerationOperation` on
every change. **Never add it to `LAN_EVENTS`.**

### `ModerationOperation` (wire, camelCase)

```json
{
  "operationId": "uuid",
  "sessionId": "…",
  "messageId": "…",
  "platform": "youtube|twitch|kick|x",
  "targetId": "…?",
  "authorName": "coders_x",
  "excerpt": "≤ 140 chars of the message",
  "source": "manual|orcle-voice",
  "reason": "toxic?",
  "phase": "pending-confirm|cancelled|expired|executing|removed|hidden-locally|failed|delivery-unknown",
  "confirmMode": "confirm|countdown",
  "requiresExplicitConfirm": true,
  "confirmBy": "ISO time?",
  "executeAt": "ISO time?",
  "outcome": "plain sentence?",
  "outcomeCode": "removed|missing-scope|unsupported|quota-paused|too-old|provider-error|not-found?",
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

**Phase rules:**

- `Manual` requests go straight to `executing`.
- `OrcleVoice` requests start in `pending-confirm`:
  - In `confirm` mode, `confirmBy` is 20 s out. With no answer the operation
    becomes `expired`.
  - In `countdown` mode, `executeAt` is 5 s out. The operation runs then
    unless cancelled.
  - On YouTube, `requiresExplicitConfirm` is always true and the countdown
    never runs.
- On restart, `pending-confirm` becomes `cancelled` and `executing` becomes
  `delivery-unknown`.

### Destination capability

Each destination's live chat status gains `moderate`:
`"ready" | "missing-scope" | "unsupported" | "paused"`. It sits next to the
existing `write` state (optional on the wire; absent when no account is
connected).

### Local tombstones (S4 writes them, S6 renders them)

Both terminal outcomes rewrite the original chat row in place through the
normal inbound tombstone path: same app id, `isDeleted: true`,
`eventType: "deleted"`, empty `fragments`. A row tells them apart by
`rawProviderType`:

| `rawProviderType` | `messageText` | Meaning |
| --- | --- | --- |
| `videorc.removed` | `Removed by you` | The platform deleted it; viewers no longer see it. |
| `videorc.hidden` | `Hidden in Videorc` | The platform could not delete it; viewers still see it. |

A provider's own deletion keeps its provider type (Twitch
`channel.chat.message_delete`, YouTube/Kick `message-delete`). The matching
`ModerationOperation` carries the plain `outcome` sentence and `outcomeCode`.

## B. Orcle command state and settings (desktop, S3, read by S6)

### `CohostState.command?`: the latest command (absent when none)

```json
{
  "id": "cmd-uuid",
  "heard": "orcle highlight the comment from coders x",
  "kind": "highlight|clear|remove|confirm|cancel|unknown",
  "status": "done|not-found|ambiguous|confirm|refused|unavailable|cancelled|expired",
  "message": "Highlighted coders_x's comment.",
  "target": { "messageId": "…", "authorName": "coders_x", "platform": "twitch", "excerpt": "…" },
  "candidates": [{ "messageId": "…", "authorName": "…", "platform": "…", "excerpt": "…" }],
  "operationId": "uuid?",
  "reason": "toxic?",
  "at": "ISO",
  "expiresAt": "ISO?"
}
```

- `candidates` holds at most 3 entries.
- `operationId` is set for removals.

### RPCs

| RPC | Params | What it does |
| --- | --- | --- |
| `cohost.command.choose` | `{commandId, index}` (index 0–2) | Picks from an ambiguous command. |
| `cohost.command.confirm` | `{commandId}` | Confirms through to the moderation operation. |
| `cohost.command.cancel` | `{commandId}` | Cancels it. |

All three are also reachable through the Comments-window relay.

### `CohostSettings` additions (persisted, `cohost.settings.set` patch fields)

| Field | Values | Default |
| --- | --- | --- |
| `wakeWordRequired` | boolean | `false` |
| `removeConfirm` | `"confirm" \| "countdown"` | `"confirm"` |

### `CohostSessionReport.commands?`: counts only

```json
{ "highlighted": 0, "cleared": 0, "removed": 0, "hiddenLocally": 0, "cancelled": 0, "expired": 0, "failed": 0, "notFound": 0 }
```

## C. Highlight source

Command highlights use `CohostAutoHighlight.source = "command"`. The source is
an existing free string, so this is not a new enum value.

## D. Desktop service flags (web → desktop, S7 + S3/S4)

`GET /api/desktop/service-flags` gains an optional top-level `orcle` object:

```json
{ "orcle": { "voiceCommands": true, "remove": true } }
```

- A missing object or missing field means enabled.
- `voiceCommands: false` stops command detection.
- `remove: false` refuses every `orcle-voice` moderation request with
  `disabled`, and shows "Removing messages is paused by Videorc."
- Manual removal is unaffected.

## E. Cloud command parser (optional, S8)

### Request

`POST /api/ai/cohost/command`, with Bearer auth. The body is at most 16 KB:

```json
{
  "clientVersion": "videorc-desktop/0.9.x",
  "sessionClientId": "…",
  "consentToProcessChat": true,
  "seq": 12,
  "utterance": "orcle can you show what coders x just asked",
  "focusMessageId": "…?",
  "candidates": [{ "id": "m1", "author": "coders_x", "text": "…", "at": "ISO" }]
}
```

- `utterance` is 1–300 characters.
- `candidates` holds 1–20 entries, with unique ids. `author` is at most 120
  characters and `text` at most 500.

### Response 200

```json
{
  "seq": 12,
  "intent": { "choice": "highlight", "probabilities": { "highlight": 0.91, "remove": 0.02, "clear": 0.01, "none": 0.06 } },
  "targets": [{ "messageId": "m1", "probability": 0.88 }],
  "usage": {}
}
```

- The model never emits ids; targets map back from question indexes.
- The desktop owns the thresholds: act at intent ≥ 0.7 and target ≥ 0.75,
  otherwise show a chooser or "didn't catch that".

### Gates

Gates run in the same order as the spotlight route: session, body, schema,
consent, then `decideCohostAccess`. A request fails with:

- 403 `"Orcle requires Videorc Premium."` without `liveCohost`;
- 503 `command-disabled` when `VIDEORC_AI_COHOST_COMMAND_DISABLED` is set;
- 503 `judge-unconfigured` without a Jev model;
- 429 when the daily cap `VIDEORC_AI_COHOST_DAILY_COMMAND_LIMIT` (default 300)
  is reached.

The timeout is `VIDEORC_AI_COHOST_COMMAND_TIMEOUT_MS` (default 2000). Usage is
recorded as kind `cohost-command`.

### Capabilities (new keys only)

- `features.cohostCommandEnabled`: true only when the command route is enabled
  and Jev is configured.
- `limits.dailyCommandCalls`.

The desktop calls the parser only when that flag is true, Orcle heard the wake
word, and the local grammar matched nothing.
