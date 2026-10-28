# Plan 211: Buddy talks only in its bubble, and Auto is gone

> **Executor instructions**: read `AGENTS.md`, the `videorc-design` skill
> (Phase C) and this whole plan first. Work in `~/projects/videorc-wt-211`
> (branch `plan-211-buddy-bubble-only`, cut from `origin/main` `00a4dc7c`),
> never in the shared checkout: it sits on `feat/windows-owner-waiver`, which
> has none of the Buddy code this plan names. This is **one desktop PR**:
> the stored field, the relay and the control change shape together, so no
> phase can ship alone. Work the phases in order. Write and commit every
> slice first, then run the gates once at the end (owner feedback "Gates at
> the end"). Check every UI in light AND dark. Stop and report on any STOP
> condition instead of improvising. When the PR lands, update the Status
> table here and the entry in `plans/README.md`.
>
> **Drift check (run first)**:
> `git log --oneline 00a4dc7c..origin/main -- crates/videorc-backend/src/cohost*.rs crates/videorc-backend/src/buddy_overlay.rs crates/videorc-backend/src/buddy_animator.rs crates/videorc-backend/src/agent_chat.rs protocol-fixtures/agent-tools.json apps/desktop/src/renderer/src/lib/buddy-auto-chat-view.ts apps/desktop/src/renderer/src/components/stream-manager/buddy-chat-controls.tsx apps/desktop/src/renderer/src/lib/studio-actions/buddy.ts apps/desktop/src/main/index.ts`.
> Line numbers were read at `origin/main` `00a4dc7c`. If an anchor moved,
> find it again by symbol. If the _behaviour_ changed, stop and report.

## Status

| Phase | What                                                          | State   |
| ----- | ------------------------------------------------------------- | ------- |
| A     | The engine: Bubble replaces Auto; nothing automatic posts     | PLANNED |
| B     | Bubble pacing, answers name the asker, visibility, reports    | PLANNED |
| C     | The Stream Manager control, the Say box, copy, reports        | PLANNED |
| D     | Agents (MCP): `set_buddy` and `buddy_say` follow the new mode | PLANNED |
| E     | Smokes, docs, the release note and the owner's live take      | PLANNED |

- **Status**: PLANNED 2026-10-28. The owner answered all three questions the
  same day (see Owner answers). Ready to execute from Phase A.
- **Priority**: P0. The owner hit it live twice (2026-10-26 and 2026-10-28).
- **Effort**: L in total. A is M, B is M, C is M, D is S, E is S plus the
  owner's stream.
- **Risk**: MEDIUM.
  - A new mode value in stored settings breaks older apps (the plan 192
    S1.1 trap). D3 avoids it.
  - Users saved on Auto lose a mode. D4 moves them to Bubble, which never
    posts, so the change is in the safe direction. The release notes say so
    (S-E3).
  - The invariant is structural: after Phase A, no code path takes a line
    from the lane to chat without a click. One test guards it (S-A5).
- **Supersedes**: plan 202 Phases B, C and D (Bubble as a fourth mode beside
  Auto). Plan 202 keeps only Phase A, "Show on takeovers", and runs next as
  its own PR (owner answer 3). This plan doesn't touch takeovers.
- **Depends on**: nothing. Plan 192's built-in lines, AI greetings, throttle,
  dedupe and collapse stay as they are. Plan 209's MCP is merged and
  unreleased, so its Buddy tools can change shape without breaking anyone.
- **Route**: the Orchestrator owns it (fit 10).
  - Phases A and B: Implementation (fit 8) on `fable-5.1`. They change how
    Buddy speaks and carry a storage trap.
  - Phase C: UI/Product Design (fit 9) on `opus-5.5`, with the
    `videorc-design` skill.
  - Phase D: Implementation (fit 7) on `gpt-6.1-sol`. It's a clear schema and
    copy change.
  - Phase E: `gpt-6.1-sol` for the smoke rows. The owner runs the live take.

## The owner's ask (2026-10-28)

> "I again had the same problem on my live stream I want my buddy just to
> talk with the bubble and not to directly chat with everyone in Stream
> Manager. When someone new enters the chat I want Buddy to greet with a
> bubble visually, not inside the chat, instead of me. We currently have
> auto suggest and off. We need to remove auto. We don't want to send in
> messages automatically. We want only to send bubble messages from Buddy
> automatically. Plan it out properly and if you have any questions ask me."

## What happened on 2026-10-28

Read from the owner's `videorc.sqlite3` (read-only):
`cohost_reports` session `0c71254b`, and `app_settings.cohostSettings` and
`overlayLayout`.

- **The stream.** "How to Build UI with AI (LIVE)", 14:13 to 16:37 UTC. 371
  messages, 16 first-time chatters.
- **Auto posted as the streamer.** At 15:14 Buddy (persona "Golmar") posted
  an AI welcome to chat under the owner's name: "Welcome back to the warband,
  francoisbest! By the way, you can always ask me, Golmar, anyt…". That was
  the only post (`posts[]` has one row).
- **Then Off, and silence.** The owner switched to Off. 46 greetings were
  skipped as `modeOff`, so nobody else was greeted at all, on stream or in
  chat. Off and Auto were the only choices for "greet people automatically".
- **Saved now.** The mode is `off`. Greetings are on with AI. Answers and
  Banter are off. Buddy Live is off. Buddy is on stream (`showOnStream`
  true, `showInRecording` false).
- **Plan 202 never ran.** On 2026-10-26 the owner asked for this same thing.
  Plan 202 planned Bubble as a fourth mode beside Auto, but it stayed
  PLANNED. Nothing in it was built.

## What a streamer gets

1. **One control, three choices.** The Stream Manager's Buddy pane says
   **Golmar talks: Off · Bubble · Suggest**. Auto is gone. Bubble is the
   default for new installs. Picking Bubble asks nothing, because Buddy posts
   nothing as you. The line under the control says "Golmar talks on stream
   in its bubble. Nothing goes to chat."
2. **Someone new chats.** Ada types her first message. Buddy waves, and its
   bubble says "Welcome, Ada!" on stream. Chat shows nothing from Buddy, and
   nothing appears under the streamer's name.
3. **A burst.** Three first-time chatters arrive within seconds. The bubble
   says "Welcome Ada, Bo and Kim!" once. Three bubbles don't wipe each other
   out.
4. **A follow, a sub, a raid.** Buddy greets each one in its bubble with the
   built-in line or the streamer's own.
5. **An answer (Premium, Buddy Live on).** A viewer asks Buddy something by
   name. The bubble says "@Ada It's Rust today, we're writing a parser!", so
   the audience knows who is being answered. Chat gets nothing.
6. **The Say box.** It always speaks in the bubble only, in every mode. The
   "Also posts to chat as you" line is gone.
7. **Suggest doesn't change.** Each line is a card in the pane, and one click
   posts it to chat as you. It bubbles when it lands. Nothing shows on
   stream until you click.
8. **Buddy isn't on stream.** In Bubble mode while live, the pane says
   "Golmar isn't on stream. Viewers can't see its bubble, so Bubble says
   nothing." with a Show on stream button. It shows whether or not Buddy
   Live is on.
9. **Someone who used Auto updates.** They're on Bubble. Buddy stops posting
   in their chat and greets on stream instead. The release notes say it in
   one line.
10. **After the stream.** Buddy → Reports lists every bubble line under
    "Said on stream", next to anything posted from Suggest cards.

## What exists (facts, `origin/main` `00a4dc7c`)

### The mode and its storage

- **The mode.** `CohostAutoChatMode` is `Off | Suggest | Auto`, kebab-case,
  with Off as the default (`cohost.rs:637`). It is stored as
  `app_settings.cohostSettings.autoChat.mode` (`CohostAutoChat`, 852).
  `CohostAutoChat::default()` sets Off (879).
- **The load trap.** `load_cohost_settings` (`cohost.rs:1186`) falls back to
  defaults when the stored JSON doesn't parse. An older app that meets a new
  enum value such as `"mode": "bubble"` would load defaults, and its next
  save would wipe the persona. Plan 192 S1.1 avoided this trap. A new struct
  field with a serde default is safe, because no Buddy settings struct uses
  `deny_unknown_fields`.
- **`normalized()`** (`cohost.rs:1106`) runs on every load, and
  `validated_patch` (1161) runs on every save. The whole `autoChat` block is
  replaced on a patch (`apply`, 1153).

### The lane

- **Every entry point returns early on Off.** These are `note_activity`
  (`cohost_auto_chat.rs:425`), `drain` (476), the AI greet result (653),
  `route_answer` (739), `banter_allowed` (800) and `route_banter` (832).
- **`route` (`cohost_auto_chat.rs:337`) has two outputs.** Auto pushes the
  utterance to `pass.send` (357), and Suggest pushes it to `pass.propose`
  (367). No automatic output skips chat.
- **Answers need a destination.** `route_answer` skips an answer whose chat
  row is unknown (755). It admits it through the destination's limiter
  (760), and in Auto notes the send (774).
- **Answers don't carry the asker's name.** `AnswerCandidate` is built at
  `cohost.rs:3848` from the first message id, without the author.
- **The Say box.** `say()` (`cohost_auto_chat.rs:863`) sends only in Auto
  (876). Otherwise the line is `bubble-only`.
- **Reactions.** A greeting template's reaction plays only when the mode
  isn't Off (`buddy_animator.rs:1107`).

### The sends

- **`send_automatic` (`cohost.rs:7861`) has three callers.**
  1. Auto's lane pass: `publish_auto_chat_pass` spawns it for each
     `pass.send` line (7610).
  2. A Suggest card the streamer clicked: `approve_utterance` (8120, spawn
     at 8137).
  3. The Say box in Auto: `say_utterance` (8171, spawn at 8221).
- **Its mode gate** (7877) refuses Off, allows Suggest only for a
  `proposed` non-manual card, and allows anything in Auto.
- **The bubble shows only after a send lands as `sent`** (8044). Automatic
  words therefore reach the bubble only through chat today.

### The bubble

- **One way in.** `buddy_overlay::show_bubble` (`buddy_overlay.rs:286`) is
  the only way a bubble appears. `show_for_utterance` (261) is the gate in
  front of it:
  - `utterance_bubbles` (251) passes `sent`, `bubble-only` and manual lines;
  - `overlay_enabled` (242) requires `showOnStream || showInRecording`.
- **Buddy is on no output by default.** The default layout is
  `snapped_item(OverlayItem::Buddy, BottomRight, false, false)`
  (`overlay_layout.rs:274`).
- **A new bubble replaces the current one at once.** There is no queue, so a
  greeting 5 s in cuts off a long answer.
- **Length limits.**
  - The bubble stays up `max(2.5 s, 60 ms × chars)`, at most 10 s
    (`buddy_bubble_duration`, 48).
  - `validate_say_text` refuses anything over `BUDDY_SAY_MAX_CHARS` = 200
    (211). The bubble is then skipped with only a warn log.
  - Tick answers can be up to 2000 UTF-16 units. A long answer therefore
    never reaches the bubble.

### The throttle

- `cohost_throttle.rs` is keyed by destination:
  - at most 6 sends a minute, and at least 5 s apart;
  - a cooldown per kind, with bursts of more than 3 collapsing into one
    greeting;
  - one greeting per (destination, viewer, kind) a session.
- **Viewer keys aren't qualified by platform.** `viewer_key` is the raw
  author id (`cohost_greetings.rs:382`). That was safe only because the
  destination already named the platform.

### Agents (plan 209, merged 2026-10-28, unreleased)

- **`set_buddy`** (`studio-actions/buddy.ts`) takes
  `chatMode: off | suggest | auto` (`MODES`, 23). It requires Premium for
  any `chatMode` (41), which the Stream Manager's control doesn't. It saves
  through `mergeAutoChatRelayPatch({ mode })`.
- **`buddy_say`** (`agent_chat.rs:379`) posts to chat in Auto (400) and
  answers with `chatMode` in its output (413).
- **The catalog** (`protocol-fixtures/agent-tools.json`) declares the
  `["off", "suggest", "auto"]` enum three times: `buddy_say`'s output at
  1663, and `set_buddy`'s input and output at 1695 and 1712. The
  `buddy_say` and `set_buddy` descriptions name Auto.
- **The docs.** `docs/agents-mcp.md:135-136` describe both tools with Auto.
- **The planner.** Buddy's videorc.com planner gets the tool schemas from
  the desktop in each request (`cohost.rs:22357`), so production follows the
  catalog. The web's `tests/fixtures/buddy-act-eval.ts:304` has its own copy
  of the enum for evals only.
- **`send_chat_message` is a Buddy tool** (`agent_tools.rs:1011`, plan 209
  D15). Buddy's planner can post in chat, but only when the streamer tells it
  to by voice or `/buddy`, and then it shows an on-air notice.

### The UI and the relay

- **The control.** It lives in `stream-manager/buddy-chat-controls.tsx`,
  labelled `BUDDY_POSTING_LABEL` = "Chat posting"
  (`lib/buddy-auto-chat-view.ts:47`). `BUDDY_MODES` (41), `BUDDY_MODE_LABELS`
  (36) and `BUDDY_MODE_HINTS` (50) define the choices and the line under the
  control.
- **Consent.** `buddyModeChangeStep` (122) shows the posting consent the
  first time the mode leaves Off, and an Auto confirm every time
  (`BUDDY_AUTO_CONFIRM_SENTENCE`, 111).
- **The promise.** `BUDDY_POSTS_PROMISE` (33) reads "Buddy posts only in the
  modes you turn on. Everything is off by default." It appears in
  `cohost-settings-section.tsx:324` and `buddy-tab.tsx:348`.
- **The relay.**
  - `CohostAutoChatMode` is at `shared/backend.ts:5819`, `CohostAutoChat` at
    5918 and `CohostAutoChatRelayPatch` at 7403.
  - `cohostAutoChatRelayPatch` (`main/index.ts:3381`) validates `mode`
    against `off | suggest | auto`.
  - `mergeAutoChatRelayPatch` (`lib/cohost-state.ts:83`) rebuilds the block
    from named keys. **Any new key in `autoChat` is dropped there** unless it
    is added on purpose. `DEFAULT_COHOST_AUTO_CHAT` is at 66.
  - The comments window saves `{autoChat}` too (`comments/main.tsx:702`), and
    so does `use-studio.tsx:5416`.
  - The strict contract has `cohostAutoChatSchema`
    (`backend-rpc-contract.ts:3037`).
- **Other readers of the mode.**
  - `sayPostsToChat = live && mode === 'auto'` (`stream-manager.tsx:1101`).
    It drives the Say box's "Also posts to chat as you" line
    (`cohost-pane.tsx:780-795`).
  - The command palette keywords for Buddy → Chat (`command-palette.tsx:99`)
    include `auto`.
- **The "not on stream" notice.** `buddyOffOutputsNotice`
  (`lib/buddy-output-notice.ts:38`) shows only while Buddy Live is on.
  Greetings run without Buddy Live, so in Bubble mode the notice would never
  show for a free user.
- **Greetings copy.** `buddy-greetings-section.tsx:122` says "What Buddy
  posts as you … Greetings go out only in the modes you turn on in Stream
  Manager, at most six a minute per platform."

### Reports and smokes

- **Reports.** `CohostSessionReport.posts[]` (`protocol.rs:5730`, capped at
  200 by `COHOST_REPORT_POSTS_CAP`, 5616) records chat sends only. Bubble
  lines aren't recorded anywhere.
- **`smoke:live-chat-fake-providers`** drives greetings through the fake
  providers in Auto, with three templates, and asserts the sends and
  `posts[]` (`scripts/smoke-live-chat-fake-providers.mjs:712-830`).
- **`smoke:agent-mcp`** B7 calls `buddy_say` and `set_buddy`
  (`scripts/smoke-agent-mcp-app.mjs:1431-1465`).
- **Fixtures.** `protocol-fixtures/high-risk-contracts.json:590` carries
  `"mode": "suggest"`.

## Decisions (owner answers of 2026-10-28 folded in)

### The mode

- **D1. One control with three values: "{name} talks: Off · Bubble ·
  Suggest".** Auto is removed everywhere: the control, its confirm, the Say
  box's chat path, `buddy_say`'s chat path, `set_buddy`'s values, the agent
  docs and the command palette.
  - **Bubble**: Greetings, Answers and Banter speak in the bubble only.
    Nothing ever goes to chat.
  - **Suggest** (owner answer 2: keep it as it is): a card per line in the
    pane. One click posts it in chat as the streamer, and it bubbles when it
    lands. Nothing shows on stream before the click.
  - **Off**: Buddy says nothing on its own.
  - The order runs from least reach to most, as plan 202 D1 had it.
  - The label is "{name} talks", falling back to "Buddy talks", because
    Bubble isn't chat posting. Plan 202 D1 had this label approved.
- **D2. Nothing Buddy does on its own reaches chat.** This is enforced by
  structure, not only by a test.
  - `AutoChatPass.send` is deleted, so the lane can't hand a line to a send.
  - The one remaining path from Buddy's lane to chat is `approve_utterance`,
    the click on a Suggest card. `send_automatic` is renamed `send_approved`.
    Its gate allows only a `proposed`, non-manual card while the mode is
    Suggest.
  - The Say box and `buddy_say` are bubble-only in every mode.
  - What still posts as the streamer, each only on the streamer's own
    action: a Suggest card click; the streamer's own chat composer; an
    agent's `send_chat_message`, with its on-air notice; and Buddy's planner
    using `send_chat_message` when the streamer tells it to by voice or
    `/buddy`. The last one is an order, not Buddy talking on its own, so it
    stays (plan 209 D15).
- **D3. Storage that older apps survive.**
  - A new field `autoChat.talk: "off" | "bubble" | "suggest"` is the one
    truth for this and every later app.
  - The backend also writes `autoChat.mode` as the projection older apps
    read. Off is saved as `off`, Bubble as `off` and Suggest as `suggest`.
    The backend never writes `auto` again. An older app on a Bubble profile
    is therefore quiet, which is the safe direction: it never posts what the
    streamer didn't choose.
  - On load, `talk` wins if it is present. Otherwise it comes from `mode`:
    `off` gives Off, `suggest` gives Suggest, and `auto` gives Bubble (D4).
  - The renderer reads and writes only `talk`. Only the backend's
    normalization writes `mode`.
  - An older app that saves drops `talk`, because serde doesn't keep unknown
    fields. The next new app then reads `mode`. If the older app picked Auto,
    the new app reads Bubble. If it saved anything else on a Bubble profile,
    the new app reads Off. Both are quiet, so the two fields can't disagree
    in the unsafe direction.
- **D4. Where people start** (owner answer 1).
  - **New installs start in Bubble.** That is `CohostAutoChat::default()`,
    and also any stored settings without an `autoChat` block. Buddy is on no
    output by default, so a new install shows nothing until the streamer
    puts Buddy on stream. From then on it greets.
  - **Saved Auto becomes Bubble** on the first load, through D3.
  - **Saved Off stays Off**, and saved Suggest stays Suggest. The owner is
    saved on Off today, so they pick Bubble once.
  - No other saved setting changes.
- **D5. Consent.** Bubble asks nothing, because Buddy posts nothing as you.
  Suggest keeps the posting consent the first time it is chosen, since a
  click posts as you. The Auto confirm and `BUDDY_AUTO_CONFIRM_SENTENCE` are
  deleted.
- **D6. The promise becomes stronger and true.** `BUDDY_POSTS_PROMISE`
  becomes "Buddy never posts in your chat on its own." The wording is the
  owner's to change at the by-eye check. The old "Everything is off by
  default" would be false now that Bubble is the default.

### Bubble behaviour (carried over from plan 202 D4 to D7 and D9, minus Auto and takeovers)

- **D7. Bubble lines are paced for reading, not for chat limits.**
  - **Greetings.** In Bubble mode the throttle treats the bubble as one
    destination named `bubble`, shared by every platform. That keeps 6 lines
    a minute, 5 s apart, the kind cooldowns and the collapse ("Welcome Ada,
    Bo and 3 others!"). The dedupe key gets the platform
    (`"{platform}:{viewer_key}"`), because the destination no longer names
    it.
  - **Answers and Banter** skip the destination limiter in Bubble mode, and
    an answer no longer needs its chat row's destination. Their own
    cooldowns (Answers 20 s, Banter 240 s) still hold. The bubble queue
    below stops any overlap.
  - **No automatic line cuts another short.**
    - A new automatic line waits for the current bubble to end, plus 0.5 s.
    - At most 3 lines wait, and a line that has waited 20 s is dropped. Both
      are counted as `stale` and logged once a session.
    - The streamer's own Say line still shows at once and replaces whatever
      is up. The queue resumes after it.
    - A Suggest card that lands goes through the queue like any Buddy line.
  - **Text that is too long is clipped, not dropped.** Bubble text is
    trimmed to `BUDDY_SAY_MAX_CHARS` (200) at a word boundary with "…" before
    `show_bubble`.
- **D8. Answers in the bubble say who they answer.** With no chat thread,
  the bubble starts with "@{name} ", using the first asker's display name. It
  skips the prefix when the reply already contains the name,
  case-insensitively. Suggest's chat text is unchanged.
- **D9. Bubble speaks only when someone can see it.**
  - Buddy is visible when it is on an output (`overlay_enabled`).
  - When it isn't, greetings are skipped with a new reason, `no-bubble`. The
    skip is counted in the report and logged once per kind.
  - Answers aren't routed and Banter isn't requested, so no AI call is spent
    on a line nobody sees.
  - Plan 202 Phase A will later add "hidden by a takeover" to the same
    `buddy_visible` check. This plan adds the function with the output rule
    only.
- **D10. Bubble spends no chat budget.** Nothing is sent, so there are no
  YouTube quota calls, no destination limits and no failed-destination
  skips. Chat must still be connected for reading, because greetings come
  from chat and Activity rows. A read-only destination is enough.
- **D11. Reports keep what Buddy said on stream.**
  - `CohostSessionReport.said[]` holds `{ id, at, trigger, text, source? }`.
    It records every `bubble-only` line, automatic or from the Say box.
  - It is oldest first, capped at 200 like `posts[]`, and omitted while
    empty, so older reports read unchanged.
  - `posts[]` stays chat-only. Buddy → Reports shows a "Said on stream"
    block.

### Agents

- **D12. The MCP tools follow the mode.** Plan 209 is unreleased, so the
  shapes change without a compatibility shim.
  - `set_buddy`'s `chatMode` is renamed `talk`, with the values
    `off | bubble | suggest`, in input and output. A call with
    `chatMode: "auto"` (an agent holding the old schema) is refused with
    "Auto is gone: Buddy never posts in chat on its own. Use talk: bubble."
  - `set_buddy` uses the same gate for `talk` as the Stream Manager's
    control does (`cohostPresent`), not Premium. Bubble with the built-in
    lines is free. Turning Buddy Live on keeps its Premium and consent gate.
  - `buddy_say` is bubble-only. It is refused when Buddy is on no output
    ("Buddy isn't on the picture, so nobody would see it."). Its output
    becomes `{ bubble: true }`.
  - The descriptions in `agent-tools.json` and `docs/agents-mcp.md` say so.

### What doesn't change

- **D13. Unchanged.**
  - Suggest's routing, cards, expiry and throttle numbers, and the posting
    consent.
  - Premium and Cloud AI gating, the greet route and its daily cap, the
    built-in lines, the Buddy Live switch and the "Say hi" nudge.
  - Buddy's lines never count as the streamer greeting anyone (plan 164
    D10).
  - The web in production. The planner reads the schemas from the desktop.
  - Takeovers. Buddy still draws over them until plan 202 Phase A lands.

## Phase A: the engine (Bubble replaces Auto)

Evidence: `cohost.rs:637-890`, 1106-1196, 7421-7480, 7555-7620, 7861-7900
and 8115-8230; `cohost_auto_chat.rs` (the whole file);
`buddy_animator.rs:1107`; `agent_chat.rs:379-430`.

### S-A1 The `talk` wire (D3, D4)

1. Add `CohostTalkMode { Off, Bubble, Suggest }` (kebab-case) in
   `cohost.rs`, next to `CohostAutoChatMode`. Keep `CohostAutoChatMode`
   (`Off | Suggest | Auto`) as the legacy storage type only, with a doc
   comment saying so. Nothing in the engine reads it after this slice.
2. Add `CohostAutoChat.talk: Option<CohostTalkMode>` with
   `#[serde(default, skip_serializing_if = "Option::is_none")]`. Add the
   accessor `CohostAutoChat::talk() -> CohostTalkMode`, which falls back to
   the `mode` mapping when the field is absent.
3. `CohostAutoChat::default()` sets `talk: Some(Bubble)` and
   `mode: Off` (D4).
4. `normalized()` fills `talk` from `mode` when it is absent (`auto` gives
   Bubble), then sets `mode` to the projection (Bubble gives Off). Put this
   in a `CohostAutoChat::normalize_talk()` that `validated_patch` also
   calls, so a saved block always carries both fields in agreement.
5. `validate_auto_chat` (`cohost.rs:974`) runs `normalize_talk()` on the
   whole block a patch carries (`apply` replaces the block): `talk` wins,
   and a block without `talk` takes it from `mode`. The renderer's merge
   sends the whole block, so `mode` arrives too and is re-projected.
   `CohostSettings.auto_chat` is already `#[serde(default)]` (1083), so a
   settings row without the block loads `CohostAutoChat::default()`, which
   is Bubble.
6. Rename `auto_chat_mode()` (`cohost.rs:7475`) to `talk_mode()`, returning
   `CohostTalkMode`. Every engine reader uses it or `talk()`.
7. TS:
   - add `CohostTalkMode = 'off' | 'bubble' | 'suggest'` to
     `shared/backend.ts`;
   - give `CohostAutoChat` a required `talk` (the backend always returns it
     after normalization), and keep `mode: CohostAutoChatMode` documented as
     "legacy, for older apps; never read";
   - `CohostAutoChatRelayPatch` swaps `mode?` for `talk?`;
   - `cohostAutoChatRelayPatch` (`main/index.ts:3381`) validates `talk`
     against the three values and refuses `mode`;
   - `mergeAutoChatRelayPatch` and `DEFAULT_COHOST_AUTO_CHAT`
     (`lib/cohost-state.ts`) carry `talk`, with Bubble as the default.
     **Trap**: the merge rebuilds the block from named keys, so a key that
     isn't named there is silently dropped.
   - Update `cohostAutoChatSchema` in `backend-rpc-contract.ts`, the
     protocol fixtures (`high-risk-contracts.json:590` gains
     `"talk": "suggest"`) and every literal `autoChat` in tests.
8. Tests:
   - a round trip for each of the three values, checking the stored `mode`
     projection (Bubble is saved as `off`, and nothing is ever saved as
     `auto`);
   - stored JSON with only `mode` loads the right `talk`, including
     `auto` → Bubble;
   - stored JSON with no `autoChat` block, and no stored settings at all,
     load Bubble;
   - the old-shape parse: a Bubble block through a copy of today's
     `CohostAutoChat` (no `talk`, and the three-value enum) parses, with
     mode Off and the persona intact;
   - the relay validator refuses `auto`, `mode` and an unknown value;
   - the merge keeps `talk`.
9. **Done when**: all of the above pass.

### S-A2 The lane speaks in the bubble (D1, D2, D10)

1. `AutoChatPass` loses `send` and gains `bubble: Vec<CohostUtterance>`.
   `changed()` counts `bubble`.
2. `route()`: Bubble records the utterance as `BubbleOnly` and pushes it to
   `pass.bubble`. Suggest is unchanged. There is no third arm.
3. Replace every `mode == Off` early return with `!talk.speaks()` (Off is
   the only value that doesn't speak). These are `note_activity`, `drain`,
   the AI greet result, `route_answer`, `banter_allowed` and
   `route_banter`.
4. `publish_auto_chat_pass` hands each `pass.bubble` utterance to the bubble
   queue (S-B2). It notes `last_auto_send_at` (Banter's quiet minute) as a
   send did, and the report records the line when it shows (S-B5). Delete
   the `pass.send` spawn loop.
5. Rename `send_automatic` to `send_approved`. Its gate becomes: allowed
   only while `talk_mode()` is Suggest and the utterance is `proposed` and
   not manual. Everything else fails with "the chat mode does not allow it",
   as today. Update its doc comment: it is the click on a Suggest card,
   nothing else.
6. Bubble never enters the send path, so the YouTube breaker and the
   destination checks stay where they are and don't apply (D10).
7. **Done when**: the crate compiles with no `CohostAutoChatMode` reader in
   the engine and no `pass.send`.

### S-A3 The Say box is bubble-only (D1, D2)

1. `say()` (`cohost_auto_chat.rs:863`) always records `BubbleOnly` and
   returns only the utterance. Drop the `bool`.
2. `say_utterance` (`cohost.rs:8171`) loses its send branch and the "Auto
   mode without a chat session" fallback. It still follows the named chat
   session, emits the state and shows the bubble. Update its doc comment.
3. `agent_chat::buddy_say` (`agent_chat.rs:379`) is covered in S-D2. Make it
   compile here by dropping the Auto branch.
4. **Done when**: the existing Say tests are updated, and a new test shows
   Say in Suggest and in Bubble produces no send.

### S-A4 Reactions play in Bubble

1. `greeting_reaction` (`buddy_animator.rs:1107`) gates on
   `talk().speaks()`, so a template's reaction plays in Bubble and Suggest.
2. **Done when**: an animator test covers Bubble.

### S-A5 The invariant and the old tests

1. **Invariant test**: `nothing_automatic_reaches_chat`. In Bubble mode and
   in Suggest mode, drive every lane entry: Activity rows, a welcome, a held
   burst through `drain`, an AI greet result, an answer, banter and Say.
   Assert:
   - Bubble: every utterance is `bubble-only`, and `pass.propose` is empty;
   - Suggest: every line is a `proposed` card, and nothing is `sent` until
     `approve` runs.
2. A `send_approved` test: a `bubble-only` utterance and a manual one are
   both refused in every mode.
3. Convert the Auto tests in `cohost_auto_chat.rs` (1161 onward) and
   `cohost.rs` (21345 to 22180). Where a test asserted `pass.send`, assert
   `pass.bubble` in Bubble mode. Where it was about chat limits or the
   YouTube breaker, drive it through Suggest's `approve`. Don't delete a
   test's intent: if one only made sense for Auto, say which in the commit
   message.
4. **Done when**: `cargo test -p videorc-backend cohost buddy agent_chat`
   passes.

## Phase B: pacing, answers, visibility, reports

Evidence: `cohost_throttle.rs`, `cohost_greetings.rs:382`,
`cohost_auto_chat.rs:731-800`, `cohost.rs:3840-3860`,
`buddy_overlay.rs:40-330`, `protocol.rs:5610-5880`.

### S-B1 One bubble destination (D7)

1. In Bubble mode, before `offer_greeting`, rewrite `facts.destination_id`
   to `"bubble"` and `viewer_key` to `"{platform}:{viewer_key}"`. Collapse,
   dedupe and the kind cooldowns then work across platforms unchanged.
2. In Bubble mode, answers skip `throttle.admit` and `note_sent` and need no
   `destination_id`. Today a missing row skips the answer. In Bubble mode the
   answer goes out anyway.
3. **Done when**: a burst of 5 first-timers on two platforms gives one
   collapsed bubble plus at most one follow-up, and the same viewer on two
   platforms is greeted once per platform.

### S-B2 The bubble queue and clipping (D7)

1. `buddy_overlay` gains a bounded queue in front of `show_bubble`, for
   every line that isn't the streamer's own:
   - when no bubble is up, the line shows now; otherwise it waits until the
     current bubble's `until` plus 0.5 s;
   - at most 3 lines wait, and a fourth line or one that has waited 20 s is
     dropped, counted as `stale` and logged once a session;
   - manual Say bypasses the queue and replaces whatever is up, and the
     queue resumes after it;
   - the queue empties when the live-chat session changes.
2. A Suggest card that lands (`send_approved`'s bubble at `cohost.rs:8044`)
   goes through the queue too.
3. Bubble text is clipped to `BUDDY_SAY_MAX_CHARS` at a word boundary with
   "…" before `validate_say_text`, so long answers show instead of
   vanishing.
4. Pure tests, clock-injected like the state machine:
   - a 10 s bubble isn't replaced by a line that arrives 5 s in;
   - the queue bound and the 20 s drop;
   - Say pre-empts and the queue resumes;
   - clipping at a word boundary, and a single word longer than 200.
5. **Done when**: those tests pass.

### S-B3 Answers name the asker (D8)

1. `AnswerCandidate` gains `author_name: Option<String>`, the first asker's
   display name, from the same `known` map as `destination_id`
   (`cohost.rs:3848`).
2. In Bubble mode only, the text becomes `@{name} {text}`, unless the text
   already contains the name (case-insensitive). The result is clipped under
   S-B2 3.
3. **Done when**: tests cover the prefix, no double name, and no prefix in
   Suggest.

### S-B4 Only when visible (D9)

1. Add `buddy_overlay::buddy_visible(app) -> bool`, which today returns
   `overlay_enabled(app)`. Its doc comment says plan 202 Phase A adds the
   takeover rule here.
2. Before each lane pass, and before taking the engine lock, the engine
   computes `bubble_visible` and passes it in next to `ai`.
3. In Bubble mode, when Buddy isn't visible:
   - greetings skip with `GreetingSkipReason::NoBubble` (wire `no-bubble`;
     log text "Buddy skipped a {kind} greeting (no-bubble): Buddy isn't on
     stream.");
   - `route_answer` returns nothing;
   - `banter_allowed` is false.
4. Report wire: `greetings.skipped.noBubble?` (omitted while zero) in Rust,
   TS and the contract.
5. **Done when**: tests cover all three, and show that no greet request is
   built while Buddy isn't visible.

### S-B5 Reports keep "said" (D11)

1. Add `CohostSessionReport.said: Vec<CohostReportSaid>` with
   `#[serde(default, skip_serializing_if = "Vec::is_empty")]`. The shape is
   `{ id, at, trigger, text, source? }`, oldest first, capped at 200
   (`COHOST_REPORT_SAID_CAP`).
2. Add `append_cohost_report_said` next to `append_cohost_report_post`.
3. Write the line when it actually shows, not when it is queued. A dropped
   queued line isn't "said".
4. Manual Say lines are recorded too, with trigger `manual`.
5. Update TS and the contract.
6. **Done when**: a storage round trip passes, an old report without `said`
   reads unchanged, and the cap holds.

## Phase C: the UI

Read `.claude/skills/videorc-design/SKILL.md` first. Use shadcn components
only.

### S-C1 The control (D1, D5)

1. In `lib/buddy-auto-chat-view.ts`:
   - `BUDDY_MODES` becomes `BUDDY_TALK_MODES`, in the order
     `['off', 'bubble', 'suggest']`, typed `CohostTalkMode`;
   - the labels are Off, Bubble and Suggest;
   - `BUDDY_POSTING_LABEL` becomes `buddyTalkLabel(name)`: "{name} talks",
     falling back to "Buddy talks";
   - the hints:
     - off: "{name} says nothing on its own."
     - bubble: "{name} talks on stream in its bubble. Nothing goes to chat."
     - suggest: "Each message is a card here; one click posts it to chat as
       you."
   - The hints are the owner's to change at the by-eye check.
2. `buddyModeChangeStep` returns `'apply' | 'consent'`. Off and Bubble
   apply at once. Suggest asks for the posting consent the first time.
   Delete `'confirm-auto'`, `BUDDY_AUTO_CONFIRM_SENTENCE` and the dialog's
   "Turn on Auto?" branch in `buddy-chat-controls.tsx`.
3. `buddy-chat-controls.tsx` uses the three values on the same
   `SegmentedControl` (`size="sm"`). The behaviour chips group's accessible
   name changes from "What Buddy posts" to "What Buddy says".
4. `stream-manager.tsx:968` sends `{ talk }`, not `{ mode }`.
5. `BUDDY_POSTS_PROMISE` becomes "Buddy never posts in your chat on its
   own." (D6).
6. The command palette keywords for Buddy → Chat
   (`command-palette.tsx:99`) swap `auto` for `bubble`.
7. **Done when**:
   - unit tests cover the three values, the change steps and the relay patch
     the control sends;
   - the owner checks it by eye at the pane's narrowest and widest, in light
     and dark.

### S-C2 The Say box

1. Remove `sayPostsToChat` from `CohostPane` and `stream-manager.tsx:1101`,
   together with the "Also posts to chat as you" line and the over-cap check
   that only applied to it (`cohost-pane.tsx:686-795`). The placeholder is
   always "Say something on stream".
2. **Done when**: the pane tests are updated, and no renderer code reads
   `autoChat.mode`.

### S-C3 Saying when the bubble can't be seen (D9)

1. `buddyOffOutputsNotice` takes `talk`. It shows when Buddy Live is on
   **or** `talk === 'bubble'`, while on air, with Buddy on no output.
2. In Bubble mode the detail line is "Viewers can't see its bubble, so
   Bubble says nothing." The title and the Show on stream action stay.
3. **Done when**: pure tests cover Bubble with Buddy Live off, Bubble with
   it on, and Suggest (unchanged).

### S-C4 Copy audit

1. Read `buddy-greetings-section.tsx`, `cohost-settings-section.tsx`,
   `buddy-tab.tsx`, `cohost-pane.tsx` and the Buddy → Chat tab for words that
   assume chat or Auto ("posts as you", "go out", "in chat", "Auto"). Say
   "says" where the line goes to the bubble. Example:
   `buddy-greetings-section.tsx:122` becomes "What Buddy says when someone
   chats for the first time, follows, subs or raids. Free: every kind has a
   line until you write your own. In Bubble, Buddy says it on stream; in
   Suggest, you post it."
2. Hide the X 140-character cap warnings in Bubble mode. They still apply to
   Suggest.
3. **Done when**: the owner checks the audited copy by eye. Record the list
   of changed strings in the PR.

### S-C5 Reports

1. `buddy-report-card.tsx` gets a "Said on stream" block from `said[]`:
   time, trigger and text, in the same row style as posts. Show it only when
   `said[]` isn't empty.
2. `greetings.skipped.noBubble` joins the skip lines: "{n} not said: {name}
   wasn't on stream".
3. **Done when**: tests cover the report card and the library report, and
   the owner checks them by eye.

## Phase D: agents (MCP)

### S-D1 `set_buddy` (D12)

1. In `studio-actions/buddy.ts`: `MODES` becomes the three `CohostTalkMode`
   values, and the argument is `talk`. `chatMode: "auto"` is refused with
   the D12 sentence. Any other `chatMode` is refused with "chatMode is now
   talk: off, bubble or suggest."
2. The gate for `talk` matches the Stream Manager's: Buddy is present
   (`context.buddy`, the pane's `cohostPresent`) and its settings have
   loaded. It isn't Premium. Turning Buddy Live on keeps its Premium and
   consent gates.
3. The save is `mergeAutoChatRelayPatch(current, { talk })`. The spoken
   result is "{name} talks: Bubble."
4. The output is `{ on, talk, onStream }`.
5. **Done when**: `studio-actions/buddy.test.ts` covers the three values,
   the `auto` refusal, Bubble without Premium, and the output.

### S-D2 `buddy_say` (D12)

1. `agent_chat::buddy_say` always speaks in the bubble. It is refused when
   Buddy is on no output ("Buddy isn't on the picture, so nobody would see
   it."). The success text is "Buddy said it in its bubble." The output is
   `{ bubble: true }`.
2. **Done when**: the `agent_chat.rs` tests cover both cases, and nothing
   in it reads the mode.

### S-D3 The catalog and the docs

1. `protocol-fixtures/agent-tools.json`:
   - `buddy_say`: the description drops the chat clause, and the output
     schema is `{ bubble }`;
   - `set_buddy`: the description reads "…choose how Buddy talks (off:
     never on its own, bubble: in its speech bubble on the picture, never
     in chat, suggest: a card the streamer clicks to post in chat)…", with
     `talk` in input and output.
2. `docs/agents-mcp.md:135-136` match.
3. The web: `videorcweb` `tests/fixtures/buddy-act-eval.ts:304` is an eval
   copy. Change it to `talk` with the three values in a small web PR. It
   doesn't need a deploy before the desktop, because production reads the
   schemas from the desktop.
4. **Done when**: the catalog tests in `agent_tools.rs` and the TS catalog
   tests pass.

## Phase E: smokes, docs, the release note and the live take

### S-E1 Smokes

1. `smoke:live-chat-fake-providers`
   (`scripts/smoke-live-chat-fake-providers.mjs:712-830`):
   - The Auto scenario becomes a Bubble scenario with Buddy on stream:
     - a fake follow, a first-time chatter and a burst of 4 welcomes across
       two providers;
     - assert `cohost.buddy.state` bubbles for each greeting, collapsed for
       the burst;
     - assert **zero** fake-provider sends and no `posts[]`, and that
       `said[]` is in the report.
   - Add a Suggest row: one card, approved, lands as one send and one post.
   - The Off row stays.
   - Update the fake-activity totals in the probe test.
2. `smoke:agent-mcp` B7 (`scripts/smoke-agent-mcp-app.mjs:1431-1465`):
   `buddy_say` returns `{ bubble: true }` with Buddy on stream, and
   `set_buddy { talk: 'bubble' }` round-trips.
3. **Done when**: both smokes pass twice in a row.

### S-E2 Plan docs

1. Plan 202's Status already says "Phase A only; Phases B to D superseded
   by plan 211" (done at planning). Check it still reads true after the
   build. When plan 202 Phase A runs, it extends `buddy_visible` (S-B4) with
   the takeover rule.
2. `plans/README.md`: mark this plan's entry BUILT with the PR number.

### S-E3 Release note

The PR description carries, under "Release notes", the public line for the
next release's changelog (written at release time by the `videorc-release`
skill):

> Buddy no longer posts in your chat on its own. Auto is gone: Buddy greets
> and answers in its bubble on stream (Bubble, the new default). If you used
> Auto, you're on Bubble now. Suggest still lets you post a line to chat with
> one click.

### S-E4 The owner's live take

1. On the owner's own channels, with Buddy on stream:
   - Bubble for 20 minutes, with Greetings on (AI on), and Answers on if
     Buddy Live runs;
   - then Suggest for 5 minutes, approving one card.
2. Record it in
   `docs/acceptance/2026-xx-xx-buddy-talks-only-in-its-bubble.md`:
   - every bubble line (Buddy → Reports, "Said on stream");
   - whether any line went to chat in Bubble (it must not);
   - how bursts read on stream;
   - whether answers were clear with "@name";
   - whether the queue ever made a greeting arrive too late to make sense.

## Gates (once, at the end)

- `cargo fmt --check --all`
- `cargo test -p videorc-backend cohost buddy agent_chat agent_tools`
- `cargo clippy -p videorc-backend -- -D warnings`
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- `pnpm --filter @videorc/desktop test` (the contract, relay, control,
  pane, report and MCP tool tests)
- `pnpm test:scripts`
- `pnpm build`
- `pnpm smoke:cohost-fake`
- `pnpm smoke:live-chat-fake-providers` (S-E1 1)
- `pnpm smoke:agent-mcp` (S-E1 2)
- A light and dark by-eye pass of the Stream Manager's Buddy pane (the
  control, the Say box, the notice), Buddy → Chat and Buddy → Reports.

No recording-studio or native-preview gate: the bubble's drawing doesn't
change, only when it is asked to show. If S-B2 touches the overlay's render
state rather than only the queue in front of it, also run
`pnpm smoke:buddy-pet`.

## Out of scope

- "Show on takeovers" (plan 202 Phase A, next).
- Suggest that also bubbles at once ("Bubble + a card"). The owner kept
  Suggest as it is.
- Telling the web greet and tick routes that the line is for a bubble
  (shorter, more playful lines). The routes stay as they are.
- Voice output (TTS) for Buddy.
- Remembering regulars (plan 183, parked).

## Later

1. `surface: 'bubble'` on greet and tick requests, so the web writes for the
   bubble.
2. Hold greetings while Buddy is hidden (off stream or, after plan 202,
   under a takeover), then greet everyone in one collapsed bubble when it
   returns.

## Owner answers (2026-10-28)

1. **D4, where people start**: new installs and saved Auto start in Bubble;
   saved Off stays Off (recommended, taken).
2. **D1, Suggest**: keep it as it is: Off · Bubble · Suggest, and Suggest
   doesn't bubble before the click (recommended, taken).
3. **Scope**: "Show on takeovers" stays in plan 202 and runs after this
   (recommended, taken).
