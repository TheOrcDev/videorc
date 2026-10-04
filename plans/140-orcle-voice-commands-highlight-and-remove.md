# Plan 140: Orcle voice commands: highlight and remove comments on request

> Executor: implement the phases below in order. Use one isolated worktree of
> current main per repo, with one branch and one PR each. Read `AGENTS.md`,
> `CLAUDE.md` and `docs/orcle-live.md`. For any UI slice, also read
> `.claude/skills/videorc-design/SKILL.md`.
>
> Commit and push per slice. Run the phase gates once, at the end, per the
> owner's rule. Planning authorizes no merge, release or production setting
> change.

## Status and decisions

- **Status: EXECUTED, in review, 2026-10-04.**
  - The owner said: "Execute the entire plan and create a PR."
  - All slices S1–S9 are built. The S10 review's seven desktop findings and
    one web finding are fixed. The owner acceptance B1–B3 is still owed.
  - Owner settings owed:
    - enable `moderation:chat_message:manage` in the Kick developer app;
    - set `VIDEORC_AI_COHOST_COMMAND_ENABLED=true` on the web only when the
      cloud parser should run, after `pnpm eval:cohost-command`.
  - Desktop branch and web branch: `feat/140-orcle-voice-commands`.
  - Owner-only work stays owed:
    - acceptance B1–B3;
    - the X live id check;
    - extra X Livestream API access, if that check needs it.
- **Defaults picked by the orchestrator, 2026-10-04** (the ⚑ decisions):
  1. Structured phrases work without the wake word, and removal always
     confirms.
  2. The confirmation default is "Confirm first". The 5-second countdown is
     opt-in, and YouTube always requires explicit confirmation.
  3. YouTube deletes shed at 100% quota (`BudgetCall::ChatModerate`, like
     ChatSend).
  4. Manual "Remove from chat" is free for everyone; voice commands are
     Premium.
  5. The cloud command parser (S8) is built behind a capability flag and stays
     off until configured.
  6. The Kick scope is optional, with a Reconnect row.
- **Priority:** P1.
- **Effort:** L–XL, about 10–12 agent-days over four phases in two repos.
- **Risk:** HIGH. This is the first time Videorc deletes content on a
  platform for the streamer. That makes the action irreversible and outward
  facing, and it is covered by platform policy.
- **Baselines:** desktop `origin/main` `2b8bcf15`, which includes plan 119
  (the Orcle tab, Orcle Live, `cohost_reports`). Web `origin/main`
  `ef0df149`.
- **Path conventions:**
  - Rust paths are relative to `crates/videorc-backend/src/`.
  - Renderer paths are relative to `apps/desktop/src/renderer/src/`.
  - `shared/…` = `apps/desktop/src/shared/…`, `main/…` = `apps/desktop/src/main/…`,
    `comments/…` = `apps/desktop/src/renderer/comments/…`.
  - Web paths are relative to the videorc-web repo.
  - Line numbers are from the baselines; re-verify them after the drift check.
- **Owner ask, 2026-10-04:** "we want now Orcle to be able to highlight
  comments. If I say, for example, 'Orcle, highlight comment from coders X'.
  And we want to be able to delete comments too. Say, 'This one is toxic.
  Remove it from our chat.' Orcle should be an assistant for the streamer.
  And we need to cover it all as well on the web in the documentation about
  Orcle. Also Orcle is premium only, make sure to double-check that."
- **Owner route:** Orchestrator (fit 10), across two repos and about seven
  subsystems.
- **Model lanes:** `fable-5` for the engine, moderation, Premium and review.
  `opus-4.8` for UI and copy. `gpt-5.5` for smokes and docs; use `opus-4.8`
  if `gpt-5.5` is unavailable.
- **Commit prefixes:** `feat(orcle):`, `feat(chat):` for moderation,
  `fix(premium):`; web uses `feat(ai):` and `docs(site):`.

### Drift check

```sh
git diff --stat 2b8bcf15..origin/main -- \
  crates/videorc-backend/src/cohost.rs crates/videorc-backend/src/cohost_ack.rs \
  crates/videorc-backend/src/captions.rs crates/videorc-backend/src/clip_marks.rs \
  crates/videorc-backend/src/live_chat.rs crates/videorc-backend/src/youtube_chat.rs \
  crates/videorc-backend/src/twitch_chat.rs crates/videorc-backend/src/kick_chat.rs \
  crates/videorc-backend/src/x_chat.rs crates/videorc-backend/src/x_live.rs \
  crates/videorc-backend/src/youtube_quota.rs crates/videorc-backend/src/oauth.rs \
  crates/videorc-backend/src/comment_highlight.rs crates/videorc-backend/src/main.rs \
  apps/desktop/src/renderer/src/hooks/use-studio.tsx \
  apps/desktop/src/renderer/src/components/comment-row.tsx \
  apps/desktop/src/renderer/src/components/cohost-pane.tsx \
  apps/desktop/src/shared/backend-rpc-contract.ts
# web
git diff --stat ef0df149..origin/main -- lib/orcle-guide.ts app/orcle lib/ai lib/desktop-service-flags.ts
```

### What exists today (measured)

**How Orcle hears you**

- Two places emit finals: realtime `Completed` (`captions.rs:6119-6203`) and
  chunked `commit_chunk_transcript` (`captions.rs:6625-6703`). Both feed
  `cohost::note_transcript_final` (`cohost.rs:4310-4326`). That function sees
  every final Orcle owns, whether or not the session records a file.
- `note_transcript_final` is synchronous and uses std mutexes only ("Lock,
  append, return", `cohost.rs:4293-4295`). Speech ownership is
  `AdmittedOrcleAudio::owns_speech` (`captions.rs:3512-3534`).
- With Orcle Live on and captions off, finals come from the listen intent:
  fixed 3 s chunks that are not aligned to speech (`captions.rs:25`,
  `:5163-5170`), arriving about 3–5 s late. A spoken command is often split
  across two finals.
- Word timing exists only on chunked finals, as `CaptionSegment` relative to
  the chunk (`captions.rs:412-416`).
- `CaptionsUpdate` carries `session_client_id` and `seq` for dedupe
  (`captions.rs:2915-2923`).
- **Nothing detects "Orcle" today.** No vocabulary biasing reaches the speech
  model:
  - realtime sends only `enabled` and `language` (`captions.rs:4922-4942`);
  - chunk uploads send only `sessionClientId`, `purpose`, `audio` and
    `language` (`videorc_api.rs:869-874`);
  - the web gateway body is `{audio, mediaType}`, so the prompt and language
    are dropped (web `lib/ai/transcription.ts:724-729`).
  - Expect "oracle", "orkle", "orca" and similar.
- The "clip that" matcher (`clip_marks.rs`) is the precedent for spoken
  phrases. Its phrase table is at `:24-30`, its tail is 2 words and 6 s, its
  dedupe window is 10 s, and owners are scoped per recording (plan 097).

**Highlighting**

- Backend RPCs: `comments.highlight.status|canvases|set|clear`
  (`main.rs:9048-9074`).
  - `set` needs a renderer-drawn `pngBase64` card
    (`comment_highlight.rs:104-126`).
  - Clearing needs no renderer (`clear_comment_highlight`, `:576-578`).
- The renderer draws the card in `applyCommentHighlight`
  (`use-studio.tsx:2618-2715`).
- Orcle's `CohostAutoHighlight{generation, messageId, source, refresh}`
  (`cohost.rs:347-358`) works like this:
  - The renderer acts on each generation exactly once (`use-studio.tsx:4114-4145`).
  - `observe_overlay` settles when the card goes live, or gives up after 8 s
    (`cohost.rs:3068-3125`).
  - `source` is a free 1–32 character string (`backend-rpc-contract.ts:2276-2284`).
- Spotlight ("the comment you are talking about") comes from the web
  `/api/ai/cohost/spotlight` route. A match needs `about ≥ 0.75` and refreshes
  for 15 s (`cohost.rs:2925-3025`).
  - `spotlight_eligible` excludes flagged, deleted and owner messages
    (`cohost.rs:2803-2813`). Spotlight can therefore never point at a toxic
    message Orcle already flagged.

**Messages and names**

- Orcle keeps up to 5000 recent messages in `known`/`known_ids`
  (`cohost.rs:1264-1290`). Each `KnownMessage` holds author, text and time.
  The platform is part of the key (`:3728-3739`).
- Flags hold up to 50 entries in arrival order (`:2174-2222`). A deletion
  never clears them (`:2671-2675`).
- Fuzzy names: `name_tokens`, `name_match_forms`, `NameForms` and
  `name_forms_match` in `cohost_ack.rs:296-465`.
  - Matching is exact under 6 characters and allows one edit from 6 characters
    up.
  - `STOP_WORDS` (`:55-235`) contains "this", "one", "that", "from", "chat",
    "our" and "it". Strip command words before matching names.
- In the Comments window, "selection" is local, defaults to the top row, and
  never reaches the backend (`cohost-pane.tsx:138`, `cohost-view.ts:264-271`).
  It is not a deliberate pick.

**Chat moderation today: none**

- Nothing deletes, bans or times out anyone. Flags are labels only: "The
  desktop only labels it" (`cohost.rs:295-305`, `:674-676`). Moderation was
  deferred in plan 055 S13.
- Inbound tombstones exist. Writing one keeps the same app id and replaces the
  content in place (`live_chat.rs:1143-1176`).
  - A tombstone can never be resurrected (`storage.rs:3476-3516`).
  - It clears the on-stream card (`live_chat.rs:3127-3136` →
    `comment_highlight.rs:598-605`) and records `deleted_ids` in Orcle.
  - The renderer shows the row muted with a line-through (`comment-row.tsx:393`).
- `liveChat.send` is the outbound pattern to copy. It runs in the
  `DurableChat` lane (`main.rs:5582`) with a UUID `operationId` and an
  idempotency binding. The operation is persisted before the provider call,
  with an 8 s timeout per destination, and startup reconciles it
  (`live_chat.rs:2171-2419`, `storage.rs:3784-3802`). It uses
  `ChatSenderConfig` + `with_current_sender_token` (`live_chat.rs:695-719`,
  `:2510-2550`).
- **Platform ids and roles:**

  | Platform | Message id | Owner role |
  | --- | --- | --- |
  | YouTube | `item.id` | `isChatOwner` → "owner" |
  | Twitch | `event.message_id`; notifications have no deletable id | broadcaster badge → "owner" |
  | Kick | `payload.messageId`, via the web relay | broadcaster badge |
  | X | the relay `messageId` (format unverified) | `host_user_id` |

- Supported platforms: YouTube, Twitch, Kick, X. Facebook does not exist;
  TikTok and Instagram are unsupported (`streaming.rs:18-26`).
- **OAuth scopes held today:**
  - YouTube: `youtube.force-ssl` (`oauth.rs:2985`).
  - Twitch base: `channel:manage:broadcast channel:read:stream_key
    user:read:chat user:write:chat` (`oauth.rs:2909-2917`). Optional scopes:
    `moderator:read:followers` and `channel:read:subscriptions`.
  - Kick: `user:read channel:read channel:write chat:write streamkey:read
    events:subscribe` (`oauth.rs:49-56`).
  - X: OAuth 2 read scopes; chat sends use the OAuth 1.0a "Authorize X Live"
    credentials (`x_live.rs:459`, `:1289-1339`).
  - **Gotcha:** a Twitch reconnect requests the base set plus only what is
    passed. Every connect path must pass the union of optional scopes or it
    drops them (`oauth.rs:121-147`, `:1195-1199`).
- **YouTube quota:**
  - `YouTubeEndpoint` lives at `youtube_quota.rs:342-398`; writes cost 50.
  - `BudgetCall` classes and shedding are at `:548-588`: 80% sheds
    subscribers and thumbnails, 95% sheds viewers, 100% keeps only essentials
    and chat reads.
  - AGENTS.md:46: every new YouTube Data API call uses
    `youtube_quota::send_attempt`.
- **Fakes:** `scripts/lib/fake-youtube-api.mjs` answers DELETE on
  `liveChat/messages` as a list page (`:312-323`) and has no delete cost. The
  in-process fake connectors (`liveChat.start` `fakes`) have no moderation.
  There are no Twitch, Kick or X HTTP fakes.
- **Copy that will be false after this plan:**
  - "Nothing sends without you." (`cohost-pane.tsx:546`).
  - `docs/orcle-live.md:23` "never … moderates by itself".
  - `docs/live-chat-live-smoke-checklist.md:165-166`.
  - Web `lib/orcle-guide.ts:37` and `:141-144`, plus the blog FAQ
    (`lib/blog/posts.ts:446-450`, MDX `:20-21,74-76`).

**What the platforms allow (verified 2026-10-04 against official docs)**

| Platform | Delete call | Scope | Limits and notes |
| --- | --- | --- | --- |
| YouTube | `DELETE /youtube/v3/liveChat/messages?id=` → 204 | `youtube.force-ssl` (already held) | 50 quota units. Owner or moderator only. 403 for messages that cannot be deleted. Since the 2026-06-23 revision YouTube no longer returns `messageDeletedEvent`, so apply the local tombstone after the 204. |
| Twitch | `DELETE /helix/moderation/chat?broadcaster_id&moderator_id&message_id` → 204 | **new** `moderator:manage:chat_messages` | Messages under 6 h old only; never the broadcaster's or a moderator's. **Omitting `message_id` clears the whole chat**, so guard it. EventSub `channel.chat.message_delete` confirms. |
| Kick | `DELETE /public/v1/chat/{message_id}` → 204 (added 2025-12-02) | **new** `moderation:chat_message:manage` | No delete webhook exists, so tombstone locally. |
| X | `DELETE /2/broadcasts/{broadcast_id}/chat/{message_id}` → `{data:{deleted:true}}` | Owner or chat moderator; app whitelisted for the Livestream API (Videorc already sends X chat through it) | Running broadcasts only. Confirm live that the relay `messageId` is the id X expects. |

Ban and timeout endpoints exist on all four (YouTube `liveChatBans.insert`,
Twitch `moderation/bans`, Kick `moderation/bans`, X `chat/mutes`). They are
out of scope for v1.

YouTube API policy §III.E: an app must clearly identify a delete and get the
user's express consent before it runs. Twitch's and Kick's developer terms
allow broadcaster-directed moderation.

**Premium today (the owner asked for a double-check)**

- **Web: correct.** The tick and spotlight routes check `liveCohost` and
  return 403 "Orcle requires Videorc Premium." (`lib/ai/jobs.ts:570-572`).
  Basic never reaches the database or the gateway (tests
  `tests/ai-cohost-route.test.ts:334`, `tests/ai-cohost-spotlight.test.ts:471-480`).
  Two gaps:
  - The listen chunk route checks **`cloudAi`**, not `liveCohost`
    (`lib/ai/captions.ts:395-401`). The two are identical today but could
    drift apart.
  - The `/orcle` steps start with "Create a free account" and never name
    Premium (`lib/orcle-guide.ts:89-103`). The closing CTA
    (`app/orcle/page.tsx:308-310`) doesn't mention it either.
- **Desktop: the renderer gates, the backend mostly doesn't.**
  - `liveCohostGate` blocks the `cohost.start` effect
    (`use-studio.tsx:3907,3933-3936`). The tick and spotlight lanes pause
    without Premium (`cohost.rs:4081-4096`, `:3993`).
  - Not gated in the backend:
    - `cohost.start` itself (`cohost.rs:4566-4656`);
    - local scheduler work: greet-by-voice, promises, Say hi, dead air
      (`:5161-5206`);
    - every `cohost.*` action and setting;
    - the report RPCs.
  - Nothing stops a running Orcle session when Premium lapses mid-stream.

### Decisions (the recommendation is taken; ⚑ = the owner may override)

1. **Orcle is your assistant. It acts only when you ask.**
   - Voice commands are new. Orcle still never acts on its own beyond the
     existing opt-in auto-highlight.
   - Removing a message reverses the old "flags are labels only" rule, but
     only on your explicit command.
2. **The wake word is "Orcle".**
   - Accepted aliases: `orcle orkle orcel orkel orcl orcal`.
   - `oracle` and `orca` count only when a command verb follows within three
     words. Developers say "Oracle"; "Oracle database is slow" never fires.
   - Words before the wake word are ignored.
   - ⚑ **Structured phrases work without the wake word**, to match the owner's
     example:
     - "remove/delete it|this|that (one|comment|message) (from our/the chat)";
     - "highlight the comment|message from <name>".
     - The "Commands need 'Orcle' first" setting turns this off. It defaults
       to off, so these phrases work out of the box.
3. **The v1 command set.**

   | Command | Examples | Result |
   | --- | --- | --- |
   | **highlight** | "Orcle, highlight the comment from coders X", "Orcle, show coders X's question", "Orcle, put this one up", "Orcle, show the last comment" | Puts that comment on stream. |
   | **clear** | "Orcle, take it down", "Orcle, clear the highlight", "Orcle, remove it from the screen" | Clears the highlight. The noun decides: "screen", "stream" or "overlay" means clear; "chat" means remove. |
   | **remove** | "Orcle, remove this one, it's toxic", "This one is toxic. Remove it from our chat.", "Orcle, delete the comment from coders X" | Creates a removal request. Words like "toxic" or "spam" become the audit reason. |
   | **answer** | "yes", "remove it", "do it", "confirm" / "no", "cancel", "never mind", "stop" | Answers the open removal card. |

   - "Clip that" is unchanged.
   - Anything else after the wake word shows "Orcle didn't catch that: '…'".
     With decision 11 it goes to the cloud parser instead.
4. **Detection is local and deterministic.**
   - A pure `cohost_command.rs` holds the grammar, aliases, normalisation and
     name extraction. It sits behind a std-mutex slot on `AppState` and is
     called from `note_transcript_final` after the ownership check.
   - It dedupes on `(session_client_id, seq)` and keeps a rolling 10 s word
     window across finals, so a command split over two chunks still matches.
   - A command must end inside the newest final (the clip-phrase rule). The
     same command is deduped for 10 s.
   - The window is cleared on `clear_transcript` and on sign-out.
   - Commands run on their own spawned task, never on the tick pass, which can
     wait 12 s. The target is ≤ 1 s from final to visible feedback.
5. **Finding the target** (under the engine lock).
   - **By name:**
     1. Strip command words.
     2. Match the remaining tokens with `name_match_forms`/`name_forms_match`
        (made `pub(crate)`) against `known_ids`, newest first, within 10
        minutes.
     3. Take the newest message from the matched author. "Question" prefers an
        open question from that author.
     4. If several authors match, show a chooser.
   - **"This one / that / it" for highlight:** the spotlight (≥ 0.75), else
     the newest open question, else the newest message.
   - **"This one / that / it" for remove:** the candidates are the comment on
     stream, the newest flag that isn't deleted (≤ 2 min old), and the
     spotlight. Exactly one candidate goes straight to the confirm card;
     several show a chooser ("say 'the first one', or press 1–3").
   - **Never targeted:** the streamer's own messages, tombstones, and Twitch
     notification rows.
6. **Highlight and clear reuse the existing paths.**
   - Highlight issues a `CohostAutoHighlight` with `source: "command"`
     (`apply_auto_decision`). That skips the auto cadence rules because you
     asked, but keeps the safety rule: no deleted or owner messages.
   - A high-severity flagged message asks first: "Orcle flagged this
     (harassment). Show it anyway?"
   - Clear calls `clear_comment_highlight` directly.
7. **Removal is a durable, audited moderation operation.**
   - New `live_chat_moderation.rs` and table `live_chat_moderation_operations`.
     Columns: id (UUID), session FK, message id, platform, target, provider
     id, author, excerpt (≤ 140 chars), source (`manual` | `orcle-voice`),
     reason, phase, `confirm_by`, outcome, timestamps.
   - Phases: `pending-confirm` → `cancelled` | `expired` | `executing` →
     `removed` | `hidden-locally` | `failed` | `delivery-unknown`.
   - On restart: `pending-confirm` → `cancelled` (never act after a restart);
     `executing` → `delivery-unknown`.
   - One bounded retry is allowed, because deletes are idempotent at the
     provider. A 404 on retry counts as removed.
   - After a successful platform delete:
     - write a local tombstone with the same app id ("Removed by you") through
       `try_deliver_messages`, which persists it, redacts it, clears the card
       and updates Orcle;
     - resolve the related flag;
     - count it in the report.
   - When the platform cannot delete (missing scope, YouTube quota paused or
     shed, Twitch message over 6 h, unknown id), hide it locally with
     `raw_provider_type: "videorc.hidden"` and say so plainly: "Hidden in
     Videorc. Viewers on Twitch still see it. Reconnect Twitch to let Orcle
     remove messages."
   - Rate limits: at most 10 removals a minute, and one in flight per message.
   - The Twitch call refuses an empty `message_id` (enforced by a unit test).
   - YouTube deletes go through `send_attempt` with a new
     `LiveChatMessagesDelete` (50 units) and a new `BudgetCall::ChatModerate`.
     ⚑ It sheds at 100%, like ChatSend, so only Go Live and chat reads keep
     calling YouTube. The owner may choose "always allowed" instead.
8. **Confirmation follows YouTube's express-consent rule.**
   - ⚑ **The default is "Confirm first".** Orcle shows a removal card with the
     author, platform, excerpt and reason. You confirm by voice ("yes",
     "remove it", "do it"), Enter or a click, or cancel with "no" or Esc. The
     card expires after 20 s and nothing is removed.
   - The opt-in **"5-second countdown"** mode removes the message unless you
     cancel. YouTube targets always need an explicit confirmation, even in
     countdown mode.
   - The manual **"Remove from chat"** menu action is itself express consent
     and runs immediately.
   - The backend owns timing (`confirm_by`), because the Comments-window relay
     times out at 20 s.
9. **Premium.**
   - Voice commands are part of Orcle and Premium only.
   - **Backend fixes:**
     - `cohost.start` refuses with `premium-required` unless
       `FeatureId::LiveCohost` is entitled;
     - an `entitlements.updated` event that drops Premium stops the running
       Orcle session (report saved);
     - the command engine and voice-sourced moderation requests re-check the
       entitlement at execution.
   - Report reads stay ungated. They are the user's own local history.
   - ⚑ **Manual "Remove from chat" is a free chat feature**, not Orcle.
     Moderation is table stakes for a streaming app. The owner may make it
     Premium.
   - **Web:** the listen gate checks `liveCohost` (both flags); the new
     command route (decision 11) uses `decideCohostAccess`; the copy names
     Premium on every Orcle surface, including the `/orcle` steps and CTA.
10. **Remote kill switch.**
    - Add `orcle: {voiceCommands?: boolean, remove?: boolean}` to the desktop
      service flags (web `lib/desktop-service-flags.ts:39-81`; the schema
      strips unknown keys, so extend it).
    - The desktop reads them (they arrive in about 35 minutes) and turns off
      commands or removals with a plain status line.
    - Both default to enabled.
11. ⚑ **The cloud command parser is optional and comes last.**
    - `POST /api/ai/cohost/command` follows the spotlight pattern:
      - Jev `choice` intent (highlight / remove / clear / none) plus one yes/no
        target question per candidate;
      - the model never emits ids (provenance);
      - Premium gate, `VIDEORC_AI_COHOST_COMMAND_DISABLED`, a daily cap of
        `VIDEORC_AI_COHOST_DAILY_COMMAND_LIMIT` (default 300), a 2 s timeout,
        and usage kind `cohost-command`.
    - The desktop calls it only after it hears the wake word and the local
      grammar fails. Thresholds stay on the desktop.
    - Built behind a capability flag and off until configured.
12. **Speech biasing is best-effort.**
    - The captions/listen gateway path drops prompts, so the desktop alias
      list is the real defense.
    - Clean cut's verbatim route can take `keyterm=Orcle` through its env URL
      (owner action, no code).
    - Moving listening to a keyterm-capable provider is out of scope.
13. **UI.**
    - **Orcle tab, "Voice commands"** inside Orcle Live:
      - what you can say;
      - the wake-word setting and the confirmation mode;
      - per-platform "Remove messages" readiness, with Reconnect buttons;
      - the kill-switch status.
    - **Stream Manager Orcle pane:**
      - a command strip ("Heard: '…' → Highlighted coders_x's comment");
      - the removal card (confirm/cancel, countdown, Enter/Esc);
      - the chooser card (1–3).
    - **Chat rows:**
      - a ⋯ "Remove from chat" item (`comment-row.tsx:456-479`);
      - a `RemovalStatus` chip ("Removing…", "Removed", "Hidden in Videorc");
      - "Remove from chat" in the flag-row action bar.
    - **Main window:** a toast mirrors the open removal card when the Comments
      window is closed.
    - **Report card:** a "Commands" row: highlighted, cleared, removed, hidden,
      cancelled, failed (counts only).
    - **Copy:** "Orcle never acts on its own. It removes a comment only when
      you tell it to."
14. **Docs.**
    - **Web `/orcle`**: a new "Talk to Orcle" section covering:
      - the wake word and the phrases;
      - how "this one" is picked;
      - confirmation and safety;
      - the platform table;
      - Premium;
      - privacy (commands are understood on your computer from the text Orcle
        already hears, and removals go from your computer to the platform with
        your account).
      - Also:
        - a "What can I say to Orcle?" FAQ;
        - rewritten conflicting lines;
        - the stale "Cohost pane" text and the "010" numbering bug fixed;
        - the YouTube-chat contradiction between `/orcle` and privacy
          reconciled;
        - privacy and blog FAQ updates.
    - **Desktop:** `docs/orcle-live.md` updates and a new `docs/orcle-commands.md`.

## Slices

| Phase | Slice | Repo | Depends on |
| --- | --- | --- | --- |
| 1 | S1 Premium double-check and fixes | both | — |
| 1 | S2 Command detector (pure) | desktop | — |
| 1 | S3 Command engine: targets, pending state, highlight and clear | desktop | S2 |
| 2 | S4 Moderation engine and platform deletes | desktop | — |
| 2 | S5 Scopes and reconnects (Twitch, Kick; X check) | desktop | S4 |
| 2 | S6 Renderer: strip, cards, row actions, Voice commands, report | desktop | S3, S4, S5 |
| 3 | S7 Web docs, service flags and copy | web | S1 |
| 3 | S8 ⚑ Cloud command parser (web route and desktop client) | both | S3 |
| 4 | S9 Fakes and smokes | desktop | S3–S6 |
| 4 | S10 Review and owner acceptance | both | all |

### Phase 1: Premium and commands

#### S1. Premium double-check and fixes (fable-5, Review route)

- **Goal:** Orcle and everything new in this plan stay Premium-only, enforced
  in the backend, not just in the UI.
- **Touches (desktop):** `cohost.rs` (`start_cohost*`, the
  `entitlements.updated` handler), `main.rs` (the event wiring),
  `use-studio.tsx` (lapse feedback), tests.
- **Touches (web):** `lib/ai/captions.ts:395-401` and its tests.
- **Steps:**
  1. `cohost.start` refuses unless `FeatureId::LiveCohost` is entitled, with
     code `premium-required`. Keep the renderer gate.
  2. On an entitlement change that drops `LiveCohost`, stop the Orcle session
     through the normal `stop_session` path, so the report is saved, and
     publish `CohostState` with reason `premium-required`.
  3. Write a short audit table in the PR covering every Orcle surface (from
     "What exists today → Premium"): gated or ungated, why, and the test that
     proves it. Report reads stay ungated by decision.
  4. Web: the listen purpose checks `liveCohost` (and `cloudAi`), with a test
     that Basic gets 403 before any database work.
- **Done when:**
  - Rust tests: start refused without Premium; mid-session lapse stops Orcle
    and saves the report.
  - Web test for the listen gate.
  - The audit table is in the PR.
- **Out of scope:** copy, which is S7.

#### S2. Command detector (fable-5)

- **Goal:** turn transcript finals into typed commands, reliably and cheaply.
- **Touches:** a new `cohost_command.rs` (pure), `state.rs` (the slot),
  `cohost.rs` (`note_transcript_final` calls `observe_final`, plus clearing on
  `clear_transcript` and sign-out), `cohost_ack.rs` (make the name matchers
  `pub(crate)`).
- **Steps:**
  1. Normalise words: Unicode-aware lowercase, strip punctuation, collapse
     whitespace (reuse `name_tokens`).
  2. Implement the wake word and aliases per decision 2.
  3. Implement the grammar per decision 3. Output
     `Command {kind: Highlight | Clear | Remove | Confirm | Cancel | Unknown,
     target: Name(String) | Deixis | Last | Question | None,
     reason: Option<String>, heard: String}`.
  4. Keep the rolling 10 s word window, the "ends in the newest final" rule,
     dedupe on `(session_client_id, seq)` and the 10 s same-command dedupe.
- **Done when:** table tests cover at least 60 phrases:
  - every example in decision 3;
  - split across two finals;
  - "Oracle database is slow" → none;
  - "the oracle said remove it from chat" → none unless structured;
  - names with digits, underscores and camelCase ("coders X", "CodersX",
    "coders_x");
  - "remove it from the screen" → Clear;
  - confirm and cancel words;
  - non-English text → none.
- **Out of scope:** acting on commands.

#### S3. Command engine: targets, pending state, highlight and clear (fable-5)

- **Goal:** a detected command becomes an action, or a clear question back.
- **Touches:** `cohost.rs` (engine and state), `protocol.rs`,
  `shared/backend.ts`, the contract, fixtures, `main.rs` (RPCs and policy),
  report counters.
- **Steps:**
  1. Resolve the target per decision 5. Name matching runs with command words
     stripped.
  2. Add an optional `CohostState.command` field (shaped like `deadAirNudge`
     and `recap`, `skip_serializing_if`) for the latest command. It holds:
     - `heard`;
     - `status`: `done` | `not-found` | `ambiguous` | `confirm` | `refused` |
       `unavailable`;
     - the target summary;
     - `candidates` (≤ 3);
     - `operationId?` and `expiresAt`.
  3. Add RPCs `cohost.command.choose {index}`, `cohost.command.confirm` and
     `cohost.command.cancel`. They are also reachable by voice
     (Confirm/Cancel) and through the Comments-window relay.
  4. Highlight: `apply_auto_decision` with `source: "command"`, plus the
     high-severity flag check (decision 6). Clear: `clear_comment_highlight`.
  5. Remove: hand off to S4's `liveChat.moderation.request` with
     `source: orcle-voice` and the reason. Until S4 lands, return
     `unavailable`.
  6. Gates: an engine session (which implies Premium), the kill-switch flags
     (decision 10), and the wake-word setting.
  7. Report: a `commands` block on `CohostSessionReport` (`#[serde(default)]`,
     counts only) with `merged_with`, the TS type, the schema, the fixture and
     the view.
- **Done when:**
  - Rust tests: resolution order, chooser, refusal paths, highlight issuing
    `source: command`, clear, the report counts, and the kill switch.
  - Contract and fixture tests pass.

### Phase 2: removal

#### S4. Moderation engine and platform deletes (fable-5)

- **Goal:** remove one message from its platform safely, with an audit trail,
  or hide it locally and say why.
- **Touches:**
  - New `live_chat_moderation.rs`.
  - `storage.rs` (the table).
  - `youtube_chat.rs` (`delete_youtube_chat_message_guarded`),
    `twitch_chat.rs` (`delete_twitch_chat_message`), `kick_chat.rs`
    (`delete_kick_chat_message`), `x_live.rs` (`delete_broadcast_chat_message`).
  - `youtube_quota.rs` (`LiveChatMessagesDelete`, `BudgetCall::ChatModerate`).
  - `live_chat.rs` (the tombstone path and capability state).
  - `main.rs` (RPCs in the `DurableChat` lane, the execution policy).
  - `protocol.rs`, the contract and fixtures.
- **Steps:**
  1. Add the ledger, phases, restart sweep and idempotency per decision 7.
  2. Add RPCs:
     - `liveChat.moderation.request {operationId, messageId, source, reason?}`;
     - `liveChat.moderation.confirm {operationId}`;
     - `liveChat.moderation.cancel {operationId}`;
     - `liveChat.moderationOperations.list {sessionId}`;
     - event `liveChat.moderationOperation`.
     Never add it to `LAN_EVENTS`.
  3. Eligibility: only `message`/`paid` rows that are not deleted and not the
     owner. Twitch rows must be under 6 h old.
  4. Confirmation modes (decision 8). The backend owns `confirm_by`; on expiry
     the operation becomes `expired`.
  5. Provider calls reuse `ChatSenderConfig` and `with_current_sender_token`,
     with an 8 s timeout. YouTube goes through `send_attempt`. Twitch refuses
     an empty `message_id`. X uses the X Live credentials, and its id format
     is validated (1–19 digits).
  6. Success: tombstone ("Removed by you") through `try_deliver_messages`,
     then resolve the flag. Platform cannot delete: local hide with the plain
     reason.
  7. Add per-destination `moderate` capability state, next to `write`:
     `ready`, `missing-scope`, `unsupported`, `paused`.
  8. Rate limit: 10 removals per minute.
- **Done when:** Rust tests cover:
  - every phase transition, and the restart sweep (pending → cancelled);
  - idempotency, and the 404-on-retry rule;
  - the Twitch empty-id guard;
  - YouTube metering through `send_attempt`, and shedding at 100%;
  - local hide when a scope is missing;
  - flag resolution, and the rate limit.

#### S5. Scopes and reconnects (fable-5 backend, opus-4.8 UI)

- **Goal:** each platform's "Remove messages" readiness is honest, and
  fixable in one click.
- **Touches:** `oauth.rs` (optional scopes), `shared/platform-scopes.ts`, the
  Twitch and Kick connect paths, destination cards, the Comments-window
  scope row.
- **Steps:**
  1. Twitch: add the optional scope `moderator:manage:chat_messages`. Fix the
     reconnect so every connect path requests the union of granted optional
     scopes.
  2. Kick: ⚑ add `moderation:chat_message:manage` as an optional scope with a
     Reconnect row. The alternative is adding it to the base set, which forces
     every Kick user to reconnect.
  3. X: verify with one live call that the X Live credentials can delete. If X
     needs additional Livestream API access, record it as an owner action and
     keep X at "hide locally" until granted.
  4. YouTube: no change, because `force-ssl` covers deletes.
- **Done when:**
  - Tests cover the scope union (no optional scope is lost on reconnect) and
    the readiness states.
  - The UI rows show "Reconnect Twitch to let Orcle remove messages" and a
    matching row for Kick.

#### S6. Renderer: strip, cards, row actions, Voice commands, report (opus-4.8)

- **Goal:** you always see what Orcle heard, what it is about to do, and how
  to stop it.
- **Touches:** `cohost-pane.tsx`, `comment-row.tsx`, `chat-pane.tsx`,
  `stream-manager.tsx`, `comments/main.tsx` (relay), `use-studio.tsx`,
  `orcle-tab.tsx` and `lib/orcle-tab-view.ts`, `orcle-report-card.tsx` and its
  view model, the toasts, and the copy fixes listed under "What exists today".
- **Steps:** build everything in decision 13.
  - Keyboard: Enter confirms, Esc cancels, 1–3 picks in the chooser. Cancel
    is a sibling button, never nested inside the row button.
  - Copy, per the design skill: plain, untinted toasts, semantic tokens.
- **Done when:**
  - View-model and component tests pass for each card state.
  - By-eye screenshots in dark and light, including the Voice commands section
    and the report "Commands" row.
  - `probe:comments-window` passes.

### Phase 3: web

#### S7. Web docs, service flags and copy (opus-4.8 for copy, gpt-5.5 for code)

- **Touches:**
  - `lib/orcle-guide.ts` (new `ORCLE_VOICE_COMMANDS`, rewritten lines `:37`
    and `:141-144`, a new FAQ, a new limit), `app/orcle/page.tsx` (new
    section, the `:123` fix, numbering).
  - `lib/desktop-service-flags.ts` (`orcle` flags, schema),
    `app/privacy/page.tsx:75-97`, `lib/blog/posts.ts:446-450` and the MDX,
    `components/faq.tsx:73-87`, `lib/pricing.ts:19-20`.
  - Tests: `tests/orcle.test.ts`, `tests/blog.test.ts`,
    `tests/account-plan-features.test.ts`.
- **Steps:**
  1. Write the "Talk to Orcle" section per decision 14.
  2. Keep "never posts" and the "No." answer the tests pin, reworded to "never
     acts on its own".
  3. Add a "Get Premium" step and a Premium CTA.
  4. Keep the meta description at ≤ 175 characters.
- **Done when:** web `pnpm typecheck` (only the 2 baseline errors), `pnpm test`
  and lint pass. The `/orcle` preview reads correctly.

#### S8. ⚑ Cloud command parser (fable-5)

- **Goal:** natural paraphrases ("Orcle, show what coders X just asked")
  resolve when the local grammar can't.
- **Touches:**
  - Web: a new `lib/ai/cohost-command.ts`, `lib/ai/cohost-command-route.ts`
    and `app/api/ai/cohost/command/route.ts`; `jobs.ts` (kind, cap, switch),
    `ai-gateway/config.ts`, `capabilities.ts` (`limits.dailyCommandCalls`,
    feature flag), `docs/ai-gateway.md`, tests, and an eval script.
  - Desktop: a `videorc_api.rs` client, plus engine wiring that runs it only
    after the wake word and a local miss, with a 2 s timeout and the same
    state machine.
- **Done when:**
  - Web tests: Basic 403 before any database or gateway work, provenance,
    caps, the kill switch.
  - Desktop tests: timeout, fallback, thresholds.
  - Eval numbers are in the PR.

### Phase 4: proof

#### S9. Fakes and smokes (gpt-5.5)

- **Touches:**
  - `scripts/lib/fake-caption-service.mjs`: emit scripted command finals,
    including one split across two chunks.
  - `scripts/lib/fake-youtube-api.mjs`: DELETE → 204 and a 50-unit cost.
  - The in-process fake connectors: delete behaviour (`ok`, `missing-scope`,
    `not-found`).
  - A new `scripts/smoke-orcle-commands.mjs` and `smoke:orcle-commands`.
  - Extend `smoke:youtube-quota` with a delete under pause and shed.
- **The smoke asserts:**
  - highlight by name;
  - "this one" highlight through the spotlight fake;
  - clear;
  - removal: confirm by voice, cancel by voice, and expiry;
  - local hide with a missing scope;
  - the restart sweep;
  - a Basic account gets no Orcle and no commands;
  - the kill switch;
  - the report's command counts.
- **Done when:** `pnpm smoke:orcle-commands` passes and is added to
  `smoke:local-gates` if it runs in ≤ 3 min. `pnpm smoke:youtube-quota` and
  `pnpm smoke:live-chat-fake-providers` pass, or fail exactly as they do on
  main.

#### S10. Review and owner acceptance (fable-5, Review route)

- **Review checklist:**
  - irreversible-action safety;
  - the YouTube consent rule;
  - the Twitch empty-id guard;
  - quota metering;
  - `LAN_EVENTS` untouched;
  - serde and contract safety;
  - Premium audit completeness;
  - copy accuracy on desktop and web.
- **Owner acceptance B1:** a real multistream.
  - 10 highlight-by-name commands: at least 9 correct within 6 s.
  - 5 "this one is toxic, remove it": the right target or a chooser every
    time, and never a wrong deletion.
  - Cancel works by voice and by keyboard.
  - 60 minutes of normal coding talk, including "Oracle": 0 commands that act.
    At most 2 "didn't catch that" notes.
- **Owner acceptance B2:** a removal is verified gone for viewers on YouTube,
  Twitch, Kick and X. This includes the X id check.
- **Owner acceptance B3:** a Basic account sees the locked Orcle card, can't
  start Orcle, and gets 403 on the web routes.

## Edge cases

- **Same name on two platforms:** a chooser shows the platform icons.
- **Author renamed mid-stream:** the match uses names Orcle has seen.
- **Message already deleted by a platform moderator:** the provider answers
  404 → treated as removed. The tombstone exists already.
- **Command while Orcle is off or not listening:** nothing happens, because
  commands need Orcle's transcript. The Voice commands section says
  "Turn on Orcle Live".
- **Consent revoked mid-stream (plan 098):** listening stops, and commands stop
  with it.
- **Session stops with a pending removal:** it becomes `cancelled`.
- **App crash during `executing`:** it becomes `delivery-unknown` and is shown
  in the operation list.
- **YouTube quota paused or shed:** hide locally, plus a plain note.
- **Twitch message over 6 h, or a moderator's message:** hide locally.
- **X broadcast ended:** hide locally.
- **"Remove it" with nothing on screen and no recent flag:** a chooser of the
  last 3 messages, never a guess.
- **Voice "yes" with no open card:** ignored.
- **Overlapping commands:** the newest wins. A second removal while a card is
  open queues behind it (at most 3).

## Out of scope

- Timeouts and bans (endpoints listed above) as a later plan.
- Spoken replies (TTS), and Orcle posting to chat.
- Any automatic removal without the streamer asking.
- Commands from viewers.
- Non-English commands.
- Facebook, TikTok and Instagram moderation.
- Moving listening to a provider that accepts keyterms.

## Verification gates

Run them once, at the end of each phase.

**Desktop:**
- TypeScript: `pnpm typecheck`, `PATH=/opt/homebrew/bin:$PATH pnpm lint`,
  `pnpm format:check`, `PATH=/opt/homebrew/bin:$PATH pnpm --filter @videorc/desktop test`
  and `pnpm test:scripts`.
- Rust: `cargo fmt --check --all`,
  `cargo clippy -p videorc-backend -- -D warnings`,
  `env -u VIDEORC_PREMIUM_FEATURES cargo test -p videorc-backend`, and
  `CARGO_PROFILE_RELEASE_STRIP=false cargo build --release -p videorc-backend`.
  The strip override is needed because the local toolchain lacks
  `rust-objcopy`.
- Build: `pnpm build` and `pnpm check:renderer-assets`.
- Smokes: `pnpm smoke:orcle-commands` (new), `pnpm smoke:cohost-fake`,
  `pnpm smoke:youtube-quota`, `pnpm smoke:live-chat-fake-providers`,
  `pnpm smoke:remote-lan` (`LAN_EVENTS` unchanged) and
  `pnpm probe:comments-window`.
- Also `pnpm smoke:captions-contract` if `captions.rs` changes.

**Web:** `pnpm typecheck`, `pnpm test`, `pnpm lint`.

**Release:** per the videorc-release skill, with D3 acceptance (capture-sensitive
files change). The release notes say Orcle takes voice commands, and how
removal confirmation works.

## Owner actions

1. Answer the ⚑ decisions:
   - wake-word-free phrases;
   - the confirmation default;
   - YouTube moderation at 100% quota;
   - manual Remove free or Premium;
   - the cloud parser now or later;
   - the Kick scope as base or optional.
2. Run the acceptance stream (B1–B3), with a test viewer account on each
   platform.
3. If the X live check fails, request any additional Livestream API access.
4. Optional: point `VIDEORC_AI_VERBATIM_TRANSCRIPTIONS_URL` at Deepgram with
   `keyterm=Orcle`.

## Handoff (cold start)

- **Goal:** the streamer says "Orcle, highlight the comment from coders X" and
  it goes on stream. They say "This one is toxic, remove it from our chat",
  Orcle shows exactly which message, and removes it from the platform when
  confirmed.
- **Safety:** Orcle never acts on its own, and every removal is audited. Orcle
  stays Premium-only, enforced in the backend and on the web. The website's
  Orcle docs teach all of it.
- **Order:**
  - Phase 1: S1 and S2 can run in parallel, then S3.
  - Phase 2: S4, then S5 and S6. S4 can run in parallel with S2 and S3.
  - Phase 3: S7 right after S1; S8 last and optional.
  - Phase 4: S9, then S10.
- **Start:**
  1. Run the drift check.
  2. Make fresh worktrees from `origin/main` in both repos.
  3. Read `AGENTS.md`, `CLAUDE.md`, `docs/orcle-live.md` and the design skill.
  4. Start S1 and S2 on the `fable-5` lane.
- **Research basis:** four investigations on 2026-10-04:
  - desktop speech, highlight and Premium paths;
  - live-chat plumbing per platform;
  - web routes, docs and metering;
  - official platform and speech API docs.

  The facts are summarized above. The platform claims cite their docs in the
  research notes: YouTube `liveChatMessages.delete` and the quota table,
  Twitch Helix, docs.kick.com, and docs.x.com's livestream API.
