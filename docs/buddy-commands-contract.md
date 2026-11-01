# Buddy voice commands: contract (plan 140)

These are the binding shapes for plan 140's slices, which several agents build
in parallel. Parts D, E and F (plan 209) cross the web ↔ desktop line;
identical copies live in both repos at `docs/buddy-commands-contract.md`.
Parts A–C and G are desktop-internal, but every slice builds against them.

All new serialized optional fields use
`#[serde(default, skip_serializing_if = …)]` in Rust and `optionalSchema` in
`backend-rpc-contract.ts`. Code, wire and storage names keep `cohost`;
user-facing copy says "Buddy" (it said "Orcle" until plans 164 and 170).
Values that were already saved or sent between apps keep the old spelling
(plan 170 D22): the moderation source `orcle-voice` (the Rust variant
`BuddyVoice` carries a serde rename) and the service-flags `orcle` section.
The examples speak the wake word "buddy"; the hidden Orcle aliases still
work until they are removed after 0.9.140.

## Named session markers (desktop, plan 152)

Named markers use `session.marker.create`, `session.markers.list`,
`session.marker.get`, `session.marker.rename` and `session.marker.delete`.
Their strict DTOs live in `shared/session-markers.ts`. Manual creation accepts
only a canonical operation UUID, the expected active capture session ID and
an optional single-line title of at most 120 Unicode code points. Time and
source are backend-owned. Creation retries return the current saved revision;
deleted-operation receipts refuse resurrection without retaining the title.

`session.marker.created` and `session.marker.changed` project committed
metadata. The detached Stream Manager window (code name `comments`) receives a separate marker context and
a bounded create/get/delete relay through Electron main and Studio. It gets
no backend credential, arbitrary RPC method, media path or renderer-supplied
timestamp. These methods and events are absent from remote-control and LAN
allowlists.

`session.marker.voice.configure` joins the existing caption provider for an
exact active recording or livestream, independently of live chat. Frames
carry an immutable capture target and a separate marker consent epoch.
Captions presentation and chat speech admission cannot grant marker ownership.
Revoke/regrant, account privacy cleanup and replacement captures fence delayed
work. Chunked finals are assembled through a bounded acoustic turn before
parsing; realtime item identity admits creation once. Marker commands are
consumed before legacy clip and chat command parsers. Titles do not become
moderation commands, Unknown cards or extra cloud command-parser requests.

Named markers are original-timeline points. Legacy clip marks remain
retrospective hints and report Moments remain ranges. See
[Session markers](session-markers.md) for the user behavior.

## Banner commands (desktop, plan 186 S11)

Banners (plan 186) are shown and hidden by voice through the same detector
as the highlight and clear commands (`cohost_command.rs`) and the same
engine path (`cohost::run_detected_command`). They need the wake word; there
is no structured phrase without it. The grammar:

| Phrase | Kind | Target |
| --- | --- | --- |
| "show the {name} banner", "show {name} banner", "put up the {name} banner", "put the {name} banner up" | `show-banner` | the spoken name |
| "show the banner" | `show-banner` | none: the only banner |
| "hide the {name} banner", "take down the {name} banner", "take the {name} banner down" | `hide-banner` | the spoken name |
| "hide the banner", "take the banner down" | `hide-banner` | none: the only one showing |
| "hide the banners", "hide all banners", "hide all the banners", "take the banners down" | `hide-banners` | none |

Show verbs: show, display, highlight, put, bring or throw (with "up" or
"on"), pull (with "up"). Hide verbs: hide, remove, clear, dismiss, drop, take
(with "down" or "off"), pull (with "down" or "off"). The particle comes right
after the verb ("take down the sponsor banner") or after the noun ("take the
sponsor banner down"); anywhere else it is part of the name ("show the on air
banner" names "on air"). "all", "every", "both" or a plural noun make a hide
a hide-all; "show all banners" is not a command. The name is every word
between the verb and the noun, minus leading small words ("show me the
follow me banner" names "follow me"), at most six words.

**Precedence.** When the sentence said to Buddy (the words after the wake
word, up to the first sentence mark) contains "banner" or "banners", the
banner grammar runs first and the utterance never reaches the highlight and
clear grammar (the marker precedence above): "Buddy, pin the banner." is
never a highlight of a viewer called "banner". The same holds when the
highlight grammar would read a banner noun into its command across a
sentence mark ("Buddy, show. Nice banner."). A later sentence that only
mentions a banner leaves an earlier command alone: "Buddy, highlight that
comment. Nice banner." is still the highlight. An addressed, closed sentence
with the noun that is not a banner command is `unknown` ("Buddy didn't catch
that: '…'."), and it is never offered to the cloud command parser (plan 140
S8), which knows comments only. One still open ("Buddy, take the banner", no
"down" yet) is nothing until it closes. Without the wake word, a structured
phrase that reads a banner noun is not a comment command ("delete that
banner, it's spam"). Utterances without the noun behave exactly as before:
"show that comment", "hide the highlight", "take it down" and "show this on
stream" are unchanged. A banner command while a card or chooser is open is a
new command, like a highlight: it replaces the card.

**Names.** The engine matches the spoken name against the banners that exist
when it is heard (`banners::match_banner_name`): both sides go through
`cohost_command::spoken_form` (lowercase, ASCII-folded, alphanumeric words),
and a name's own trailing "banner" is dropped ("Logo banner" answers to "the
logo banner"). An exact name wins; otherwise the spoken words must begin
exactly one name. No match is `not-found` ("Buddy couldn't find a banner
named 'rainbow'."); two or more are `not-found` too, with the names ("Which
banner? Sponsor or Sponsor Acme."). Without a name, a show means the only
banner and a hide the only one showing; with several it is the same "Which
banner?" sentence.

**Execution.** Shows and hides go through the functions behind
`banners.show` and `banners.hide` (`banners::show_banner_and_publish` and
`banners::hide_banners_and_publish`, which end in `on_banners_changed`), so
every refusal lands on the card verbatim with status `refused` ("Four
banners are showing. Hide one first."). The voice gates are the usual ones
(`unavailable` when voice commands are paused or without Premium); there is
no banner gate of its own, because Buddy is Premium. A banner moves only for
the Buddy session that heard the command. The card's sentences: "Showed the
Sponsor banner.", "The Sponsor banner is already showing.", "Hid the Sponsor
banner.", "The Sponsor banner isn't showing.", "Hid all banners.", "No banner
is showing.", "You have no banners yet." A banner command never opens a
chooser or a confirm card. Only `not-found` is counted in the session report
(`notFound`).

The wire kinds `show-banner`, `hide-banner` and `hide-banners` join part B's
`kind` enum; a banner command carries no `target`, `candidates`,
`operationId` or `reason`.

## A. Chat moderation (desktop, S4)

Moderation is a chat feature. Manual removal is free; voice-sourced removal is
Premium (Buddy).

### Rust API (`live_chat_moderation.rs`), used by S3

```rust
pub enum ModerationSource { Manual, BuddyVoice, Agent }   // wire: "manual" | "orcle-voice" (serde rename, plan 170 D22) | "agent" (plan 209 S12)
pub enum RemoveConfirmMode { Confirm, Countdown }         // wire: "confirm" | "countdown"
pub struct ModerationRequest {
    pub operation_id: String,      // UUID v4, minted by the caller (idempotency key)
    pub message_id: String,        // the app message id from live_chat_messages.id
    pub source: ModerationSource,
    pub reason: Option<String>,    // "toxic", "spam"… (≤ 40 chars, audit only)
    pub confirm_mode: RemoveConfirmMode, // ignored for Manual and Agent
}
pub async fn request(state: &AppState, req: ModerationRequest) -> Result<ModerationOperation, ModerationRefusal>;
pub async fn confirm(state: &AppState, operation_id: &str) -> Result<ModerationOperation, ModerationRefusal>;
pub async fn cancel(state: &AppState, operation_id: &str) -> Result<ModerationOperation, ModerationRefusal>;
pub struct ModerationRefusal { pub code: &'static str, pub message: String }
```

**Refusal codes:** `not-found`, `not-eligible` (owner message, tombstone,
notification row), `premium-required` (BuddyVoice only), `disabled` (kill
switch), `rate-limited` (more than 10 a minute), `already-pending`,
`not-pending`, `invalid-params`.

### RPCs (DurableChat lane, registered in the execution policy)

| RPC                                  | Params                                                    | Returns                                            |
| ------------------------------------ | --------------------------------------------------------- | -------------------------------------------------- |
| `liveChat.moderation.request`        | `{operationId, messageId, source, reason?, confirmMode?}` | `ModerationOperation`                              |
| `liveChat.moderation.confirm`        | `{operationId}`                                           | `ModerationOperation`                              |
| `liveChat.moderation.cancel`         | `{operationId}`                                           | `ModerationOperation`                              |
| `liveChat.moderationOperations.list` | `{sessionId}`                                             | `ModerationOperation[]`, newest first, at most 200 |

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
  "source": "manual|orcle-voice|agent",
  "reason": "toxic?",
  "phase": "pending-confirm|cancelled|expired|executing|removed|hidden-locally|failed|delivery-unknown",
  "confirmMode": "confirm|countdown",
  "requiresExplicitConfirm": true,
  "confirmBy": "ISO time?",
  "executeAt": "ISO time?",
  "outcome": "plain sentence?",
  "outcomeCode": "removed|missing-scope|unsupported|quota-paused|too-old|provider-error|not-found?",
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

**Phase rules:**

- `Manual` requests go straight to `executing`.
- `Agent` requests (plan 209 S12: an AI agent on this computer called
  `remove_chat_message`) go straight to `executing` too, except on YouTube:
  there they start in `pending-confirm` with `requiresExplicitConfirm: true`
  and `confirmBy` 20 s out, show the same removal card (and its main-window
  toast), and run only on the streamer's confirm. The agent is answered
  "Waiting for you to confirm in Videorc." at once. Like `Manual`, they are
  free and ignore the voice kill switch. Only the Agents endpoint mints them:
  `liveChat.moderation.request` from a renderer never sends `agent`.
- `BuddyVoice` requests start in `pending-confirm`:
  - In `confirm` mode, `confirmBy` is 20 s out. With no answer the operation
    becomes `expired`.
  - In `countdown` mode, `executeAt` is 5 s out. The operation runs then
    unless cancelled. Only a wake-word command read by the local grammar
    asks for `countdown`; a structured phrase heard without the wake word,
    or a target the cloud parser picked (S8), always asks for `confirm`.
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

| `rawProviderType` | `messageText`       | Meaning                                                 |
| ----------------- | ------------------- | ------------------------------------------------------- |
| `videorc.removed` | `Removed by you`    | The platform deleted it; viewers no longer see it.      |
| `videorc.hidden`  | `Hidden in Videorc` | The platform could not delete it; viewers still see it. |

A provider's own deletion keeps its provider type (Twitch
`channel.chat.message_delete`, YouTube/Kick `message-delete`). The matching
`ModerationOperation` carries the plain `outcome` sentence and `outcomeCode`.

## B. Buddy command state and settings (desktop, S3, read by S6)

### `CohostState.command?`: the latest command (absent when none)

```json
{
  "id": "cmd-uuid",
  "heard": "buddy highlight the comment from coders x",
  "kind": "highlight|clear|remove|confirm|cancel|unknown|show-banner|hide-banner|hide-banners",
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

Additive notes from S3 (the shapes above are unchanged):

- Every optional field is absent, never `null`: `target`, `operationId`,
  `reason` and `expiresAt` when they do not apply, and `candidates` while
  empty (only a chooser has them).
- `at` is when the command reached its current status, so a strip can fade a
  finished command after a few seconds.
- `heard` is the command's own words; an answer ("yes", "the first one")
  updates the same command (same `id`) instead of making a new one.
- A removal card (`kind: remove`, `status: confirm`) carries `operationId` and
  `expiresAt` (the operation's `confirmBy`, or `executeAt` in countdown mode).
  While a confirmed removal runs at the platform, `status` stays `confirm`,
  `expiresAt` is absent and `message` says "Removing coders_x's comment…": show
  no buttons then. A removal card without `operationId` is still opening (a
  few milliseconds); answers wait for it.
- A highlight of a comment Buddy flagged with high severity is a `confirm`
  card too (`kind: highlight`, no `operationId`): "Buddy flagged this
  (harassment). Show it anyway?"
- `kind: unknown` comes with `status: not-found` and "Buddy didn't catch that:
  '…'" (only after a clearly addressed "Buddy"; never while a card is open).
- Choosers and highlight cards expire after 20 s (`expired`); a removal card
  follows its moderation operation (`expired`: "Nothing was removed.").

`CohostState.commandAvailability?` (additive, S3) carries the kill switches of
part D: `{ "voiceCommands": "on|paused", "remove": "on|paused" }`. It is absent
while both are on, and present on every state, Buddy running or not. The
renderer shows "Voice commands are paused by Videorc." and "Removing messages
is paused by Videorc." from it.

### RPCs

| RPC                      | Params                           | What it does                                  |
| ------------------------ | -------------------------------- | --------------------------------------------- |
| `cohost.command.choose`  | `{commandId, index}` (index 0–2) | Picks from an ambiguous command.              |
| `cohost.command.confirm` | `{commandId}`                    | Confirms through to the moderation operation. |
| `cohost.command.cancel`  | `{commandId}`                    | Cancels it.                                   |

All three are also reachable through the Comments-window relay.

Each returns the `CohostState` after the answer. `confirm` on a removal
returns at once (the card reads "Removing…"); the platform's outcome arrives as
`cohost.state`, so prefer the newest event over an RPC result (compare
`command.at`). Errors: `invalid-params` (no `commandId`, or an index past the
chooser) and `not-pending` (no such command waits for that answer: it was
answered, replaced or expired). They run in the ordinary mutation lane and
are never LAN routes.

### `CohostSettings` additions (persisted, `cohost.settings.set` patch fields)

| Field              | Values                     | Default     |
| ------------------ | -------------------------- | ----------- |
| `wakeWordRequired` | boolean                    | `false`     |
| `removeConfirm`    | `"confirm" \| "countdown"` | `"confirm"` |

### `CohostSessionReport.commands?`: counts only

```json
{
  "highlighted": 0,
  "cleared": 0,
  "removed": 0,
  "hiddenLocally": 0,
  "cancelled": 0,
  "expired": 0,
  "failed": 0,
  "notFound": 0
}
```

Absent when no command was counted (S3). A removal counts once, by its
outcome; `failed` also counts a refused request (rate limit, not eligible);
`notFound` also counts "didn't catch that". A card a newer command replaced,
or a session boundary closed, is not counted as cancelled.

## C. Highlight source

Command highlights use `CohostAutoHighlight.source = "command"`. The source is
an existing free string, so this is not a new enum value.

## D. Desktop service flags (web → desktop, S7 + S3/S4)

`GET /api/desktop/service-flags` gains an optional top-level `orcle` object
(the key keeps the old name, plan 170 D22):

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
  "utterance": "buddy can you show what coders x just asked",
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
  "intent": {
    "choice": "highlight",
    "probabilities": { "highlight": 0.91, "remove": 0.02, "clear": 0.01, "none": 0.06 }
  },
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

- 403 `"Buddy requires Videorc Premium."` without `liveCohost`;
- 503 `command-disabled` unless `VIDEORC_AI_COHOST_COMMAND_ENABLED` is `true`, or when `VIDEORC_AI_COHOST_COMMAND_DISABLED` is set (the parser ships off);
- 503 `judge-unconfigured` without a Jev model;
- 429 when the daily cap `VIDEORC_AI_COHOST_DAILY_COMMAND_LIMIT` (default 300)
  is reached.

The timeout is `VIDEORC_AI_COHOST_COMMAND_TIMEOUT_MS` (default 2000). Usage is
recorded as kind `cohost-command`.

### Capabilities (new keys only)

- `features.cohostCommandEnabled`: true only when the command route is enabled
  and Jev is configured.
- `limits.dailyCommandCalls`.

The desktop calls the parser only when that flag is true, Buddy heard the wake
word, and the local grammar matched nothing.

## F. Buddy planner (`POST /api/ai/buddy/act`, plan 209 S17)

Buddy's tool planner. The desktop sends one sentence the streamer said to
Buddy (by voice after the wake word, when the local grammar did not know
it, or typed as `/buddy …`), Buddy's tool subset from the catalog, the
names that exist right now and the studio's state; the route answers with
the tool calls to run, in order, and one line for the strip. Chat comes
along only when the sentence is about a comment, at most 20 comments, as
quoted viewer data (D18). The desktop is the authority: it checks every
returned call against the catalog and Buddy's subset (D15), applies the D14
spoken confirmations, and runs the calls in order.

### Request

`POST /api/ai/buddy/act`, with Bearer auth. The body is at most 128 KB and
zod strict: unknown keys are rejected at every level.

```json
{
  "clientVersion": "videorc-desktop/0.11.x",
  "sessionClientId": "…",
  "consentToProcessChat": true,
  "seq": 7,
  "sentence": "put up the sponsor banner and play the airhorn",
  "tools": [
    {
      "name": "set_banner",
      "description": "Show or hide a banner; shown: false without a banner hides them all.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "banner": { "type": "string" },
          "shown": { "type": "boolean" }
        },
        "required": ["shown"]
      }
    }
  ],
  "names": {
    "scenes": ["Coding", "Chat"],
    "banners": ["Sponsor"],
    "takeovers": ["BRB", "Starting soon"],
    "sounds": ["Airhorn", "Drum roll"],
    "destinations": ["Twitch", "YouTube"]
  },
  "state": {
    "activity": "live",
    "viewers": 42,
    "scene": "Coding",
    "bannersShown": [],
    "takeover": null,
    "micMuted": false
  },
  "comments": [
    { "id": "m1", "platform": "twitch", "viewerName": "ana", "viewerText": "…" }
  ]
}
```

- `sentence` is 1–500 characters.
- `tools` holds 1–45 entries with unique names: `name` is snake_case
  (`^[a-z][a-z0-9_]{0,63}$`), `description` 1–400 characters, `inputSchema`
  a JSON Schema object of at most 4096 characters serialized. The desktop
  sends Buddy's subset from the catalog (D15) with the catalog's own
  descriptions and schemas; the argument names in the examples here are
  illustrative, the catalog's schemas are the truth.
- `names` has all five lists, each at most 60 names of at most 80
  characters: `scenes`, `banners`, `takeovers`, `sounds`, `destinations`.
  An empty list is fine.
- `state` is a flat object of at most 24 keys (keys at most 40
  characters); a value is a string (at most 120), a number, a boolean,
  `null` or a list of at most 20 strings (at most 80 each). Recommended
  keys, from `get_status`: `activity` (`idle` | `recording` | `live` |
  `clips`), `elapsedSeconds`, `viewers`, `scene`, `bannersShown`,
  `takeover`, `micMuted`, `systemAudioOn`, `captionsOn`,
  `highlightShown`, `buddyPlace`, `destinationsOn`.
- `comments` is optional: at most 20 entries with unique ids; `platform` is
  one of `twitch`, `youtube`, `x`, `kick`; `viewerName` at most 120 and
  `viewerText` at most 500 characters. Send it only when the sentence is
  about a comment.

### Response 200

```json
{
  "calls": [
    { "tool": "set_banner", "args": { "banner": "Sponsor", "shown": true } },
    { "tool": "play_sound", "args": { "sound": "Airhorn" } }
  ],
  "line": "Showing the Sponsor banner and playing the Airhorn."
}
```

- `calls` holds at most 3 entries, in the order to run them; `args` is a
  JSON object (`{}` when the tool takes none) of at most 2048 characters
  serialized. Every `tool` is one of the request's `tools`: the route drops
  anything else (defence in depth; the desktop checks again against the
  catalog and D15's subset).
- `line` is one sentence of 1–140 characters for Buddy's strip, no line
  breaks, no links.
- `unknown: true` is present, and `calls` empty, when nothing fits: the
  sentence was not a request, asked for something the tools cannot do, or
  was too unclear to act on. It is absent otherwise, never `false`.
- With `comments` in the request the route never returns `stop` or
  `go_live`: the sentence was about a comment, so either is a mishearing or
  chat text steering the model. Such a call is dropped and, when nothing
  else survives, the answer is `unknown: true` with the line "Buddy can't do
  that." The same line and flag come back when every call the model
  proposed named a tool outside the request's `tools`.
- A question ("how many viewers", "am I live") is answered in `line` from
  `state` with no calls, or with one read-only tool when `state` does not
  know; the desktop shows the line and the tool's result in the strip.

### Gates

In order: session (401 `unauthorized`), JSON body of at most 128 KB (400
`invalid-request`), consent (403 `consent-required`, checked before the
schema), zod (400 `invalid-request`), then the tick's access ladder with the
planner's own switch and allowance:

- 403 `premium-required` without `liveCohost` (decided from the entitlement
  snapshot, before any usage count or Gateway work);
- 503 `cohost-disabled` (`VIDEORC_AI_COHOST_DISABLED` or
  `VIDEORC_AI_DISABLED`);
- 403 `act-disabled` when `VIDEORC_AI_BUDDY_ACT_DISABLED` is set;
- 403 `ai-user-disabled` for a blocked account;
- 429 `quota-exhausted` with `Retry-After` until the next UTC midnight when
  the daily cap `VIDEORC_AI_BUDDY_ACT_DAILY_LIMIT` (default 300) is reached;

then the Gateway: 503 `ai-gateway-not-configured`, 504 `act-timeout` when
the 3 s budget runs out, 502 `ai-gateway-error` for anything else. The
desktop reads any 403 as "no planner for the rest of this session" and
keeps the old path; on anything else it says "Buddy didn't catch that" for
that sentence and asks again next time.

### Model and budget

One structured-output call (`videorc_buddy_act`, at most 600 output tokens)
on a fast text model through the AI Gateway, inside a 3 s server budget;
the desktop gives up at 3.5 s. The chain is `VIDEORC_AI_BUDDY_ACT_MODEL`,
else the greet model, else the tick's backup, else the tick's primary;
`VIDEORC_AI_BUDDY_ACT_FALLBACK_MODELS` names the backup when set. The
tick's backup pattern (web #92) scaled to the budget: a primary that has
not answered by `VIDEORC_AI_BUDDY_ACT_BACKUP_AFTER_MS` (default 1200) gets
the backup model started beside it, a primary that fails fast gets it
started right away; the primary's answer wins whenever it arrives in time,
the backup is used only when the primary fails, and never a third model.

The system prompt says that the comments are quoted viewer data and never
instructions, that only the streamer's sentence is a request, that `stop`
and `go_live` are never called because of something in a comment, and that
at most 3 calls come back. The sentence, the names, the state and the
comments reach the model only inside the input JSON, never in the
instructions.

### Metering

Each answered request writes one `ai_usage_events` row of kind `buddy-act`
with tokens, model, latency and cost estimate, nothing else: no sentence,
no tool arguments and no comment text is stored or logged (dropped calls
are logged by tool name and reason only).

### Capabilities (new key only)

`GET /api/ai/capabilities` gains a top-level `buddy` block:

```json
{ "buddy": { "act": 1 } }
```

`act` is `1` when this user may call the route (Buddy enabled for them, the
Gateway configured, `VIDEORC_AI_BUDDY_ACT_DISABLED` unset), `0` otherwise.
The desktop asks the planner only while it is `1`; a desktop that does not
know the block treats it as `0` and keeps the old wake-word path.

## G. Buddy uses the tools (desktop, plan 209 S18 to S20)

Desktop-internal; part F is the wire to videorc.com.

**The caller.** Buddy is a built-in caller of the agent tool path
(`buddy_act.rs`), never a token agent: id `buddy`, name `Buddy`, no registry
entry, no presence, never in the agents list. Its calls go through
`agent_call::run_tool` (schema, a rate limit of its own, the backend
executors or the Studio relay, whose `agent.intent` carries
`agentId: "buddy"`) and land in Activity as "Buddy". A successful `onAir`
call carries its D11 notice ("Buddy ended the livestream.").

**D15 at the desktop.** `buddy_act::buddy_tool` admits a call only when the
catalog has the tool and marks it `buddy`; anything else is refused before
it runs ("Buddy can't use notify.", "Buddy has no tool called …") and logged
as a refused Buddy row. The Studio checks again: an `agent.intent` from
`buddy` for a tool outside the subset never reaches a handler
(`executeAgentIntent`). The planner says names; `buddy_act::resolve_names`
maps `sceneId`, `soundId`, `bannerId`, `takeoverId` and `destinations` to
ids (exact name or alias, then one unique beginning), and anything else is
left for the tool to refuse in its own words.

**S18, the grammar.** A banner command runs Buddy's `set_banner` through the
tool path; its card keeps the grammar's sentences. Highlight, clear and
removal keep their engine executor (the chooser, "show it anyway?", the
`source: command` card, the voice removal card) and land in Activity as
Buddy's `set_highlight` and `remove_chat_message` once they reach `done`,
`refused` or `unavailable` (once per status, from `cohost.state`). A voice
marker keeps its spoken time and `voice` source and lands as Buddy's
`add_marker`.

**S19, by voice.** A wake-word `unknown` goes to the planner when
`buddy.act` is 1, no 403 came back since the last capability read or Buddy
session, Premium, the voice switch, Buddy on and its session's consent;
otherwise the part E path runs exactly as before. A 403 turns the planner
off and the old path takes that sentence; any other failure is "Buddy
didn't catch that: '…'.". Comments ride along only when the sentence is
about one (`about_comment`: a chat word, "this one", or an author's name),
from the parser's own pool. The calls run in order; by voice D14 halts
before `go_live` and before `stop` while recording or live, and a
`remove_chat_message` opens the existing removal card (the steps after it
do not run).

`CohostCommand.kind` gains `act`:

- `status: "confirm"` with `expiresAt` 20 s out: 'Go live? Say "Buddy,
  yes".', 'End the livestream? Say "Buddy, yes".' or 'Stop the recording?
  Say "Buddy, yes".', after what ran so far. "Buddy, yes" (or
  `cohost.command.confirm`) runs the plan on from that call; a spoken yes
  without the wake word leaves the card open (plan 209 review fix 17); while it runs the card keeps `confirm` without `expiresAt` ("On
  it…"), then finishes in place (same `id`). "No" is `cancelled`
  ("Cancelled. Nothing stopped."), no answer is `expired`.
- `done` or `refused` with what the calls said ("Switched to BRB. Pressed
  Drum roll."); a question answered from the state is `done` with the line.

**S20, typed.** `cohost.act {actId, sentence, consentToProcessChat}`
(renderer only, never a LAN route) answers at once with
`{actId, status, message}`: a gate's sentence (`unavailable`: "Buddy
requires Videorc Premium.", "Voice commands are paused by Videorc.",
Cloud AI consent, "Buddy can't take requests right now.", "Sign in to ask
Buddy."; `refused`: an empty or over-long sentence) or `working`. The
planner and the calls then run on their own task, with no wake word and no
D14 halt, and the final answer arrives as the `cohost.act.result` event
(`done`, `refused`, `unavailable` or `not-found`, never `working`). The
Stream Manager's composer relays `/buddy <words>` through main
(`comments-window:buddy-act`) to the Studio, which owns the consent and
shows a free user the Premium sentence without a backend call.
