# Plan 202: Buddy talks in its bubble, and stays off takeovers when you say so

> **Executor instructions**: read `AGENTS.md`, the `videorc-design` skill
> (Phase C) and this whole plan first. Work in your own worktree from
> `origin/main`, never from `feat/windows-owner-waiver`: that branch is 672
> commits behind and has none of the Buddy code this plan names. Work one
> phase at a time, in order. Each phase is one desktop PR. Write and commit
> every slice of a phase first, then run its gates once at the end of the
> phase (owner feedback "Gates at the end"). Check every UI in light AND
> dark. Stop and report on any STOP condition instead of improvising. When a
> phase lands, update its row in the Status table and in `plans/README.md`.
>
> **Drift check (run first, every phase)**:
> `git log --oneline ea2879da..origin/main -- crates/videorc-backend/src/cohost*.rs crates/videorc-backend/src/buddy_overlay.rs crates/videorc-backend/src/buddy_animator.rs crates/videorc-backend/src/overlay_layout.rs crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/windows_d3d11_session.rs apps/desktop/src/renderer/src/lib/buddy-auto-chat-view.ts apps/desktop/src/renderer/src/components/stream-manager/buddy-chat-controls.tsx`.
> Line numbers were read at `origin/main` `ea2879da`. If an anchor moved,
> find it again by symbol. If the _behaviour_ changed, stop and report.

## Status

| Phase | What                                                       | PR         | State   |
| ----- | ---------------------------------------------------------- | ---------- | ------- |
| A     | "Show on takeovers": Buddy hidden on takeovers when off    | desktop PR | PLANNED |
| B     | Bubble mode in the engine: speaks on stream, never in chat | desktop PR | PLANNED |
| C     | Bubble mode in the UI: the control, the copy, the report   | desktop PR | PLANNED |
| D     | Smokes and the owner's live acceptance                     | desktop PR | PLANNED |

- **Status**: PLANNED 2026-10-26. The owner answered all three questions
  the same day (see Owner answers). Ready to execute from Phase A.
- **Priority**: P1 (owner request, 2026-10-26).
- **Effort**: A is M (one setting, three render paths, one switch). B is L
  (settings wire, lane routing, bubble pacing, report). C is M. D is S plus
  the owner's stream.
- **Risk**: MEDIUM.
  - Bubble mode must never post to chat. Today every automatic line reaches
    the bubble only after it lands in chat, so the new path is a real fork in
    the lane. One invariant test guards it (S-B2).
  - A new mode value in stored settings breaks older apps (the plan 192
    S1.1 trap). D3 avoids it.
  - Phase A changes what goes into recordings and streams on the CPU, Metal
    and Windows D3D11 paths, so it carries the recording-studio gates.
  - Phase A changes what existing users see. "Show on takeovers" starts off
    (owner answer 2), so after the update Buddy no longer draws over
    takeovers until the streamer turns the switch on. The release notes must
    say so (S-A4).
- **Depends on**: nothing. Plan 183 (Buddy remembers your regulars) is
  parked and independent. Plan 192 is built; this plan keeps its throttle,
  dedupe, collapse, built-in lines and AI greetings as they are.
- **Route**: Orchestrator owns it (fit 10).
  - Phase A: Implementation (fit 8) on `fable-5.1`. It touches composition on
    three render paths and the recording output.
  - Phase B: Implementation (fit 8) on `fable-5.1`. It changes how Buddy speaks
    and has a storage trap.
  - Phase C: UI/Product Design (fit 9) on `opus-5.5`, with the
    `videorc-design` skill.
  - Phase D: `gpt-6.1-sol` for the smoke rows; the owner runs the live
    acceptance.

## The owner's ask (2026-10-26)

> "buddy should have a mode where it's talking just with bubble, not in the
> chat. so it can be fun to the audience, currently auto chat is sending all
> to chat always. there should be also switch if buddy is visible on
> takeover screens or not. plan it out properly"

## What a streamer gets

1. **One control, four choices.** The Stream Manager's Buddy pane says
   **Buddy talks: Off · Bubble · Suggest · Auto**. Picking Bubble asks
   nothing: Buddy posts nothing as you, so there's no consent dialog. The
   line under the control says "Buddy talks on stream in its bubble.
   Nothing goes to chat."
2. **A follow.** Ada follows. Buddy waves, and the bubble says "Thanks for
   the follow, Ada!". No message under the streamer's name appears in chat.
3. **A burst.** Three first-time chatters arrive within seconds. The bubble
   says "Welcome Ada, Bo and Kim!" once. Three bubbles don't wipe each other
   out.
4. **An answer (Premium).** A viewer asks Buddy something by name. The
   bubble says "@Ada It's Rust today, we're writing a parser!", so the
   audience knows who is being answered.
5. **Dead air (Premium, Banter on).** Buddy fills the silence in its bubble.
6. **A takeover.** The streamer puts up "Be right back".
   - With **Show on takeovers** off (the default), the takeover is clean.
     Buddy disappears while the takeover shows and comes back when it ends.
     In Bubble mode it stays quiet meanwhile, and the Buddy pane says why.
   - With it on (Layout → Buddy), Buddy stays on top of the takeover and
     keeps greeting people in its bubble.
7. **After the stream.** Buddy → Reports lists every bubble line under
   "Said on stream", next to what was posted to chat.

## What exists (facts, `origin/main` `ea2879da`)

### Modes and the lane

- **The mode.** `CohostAutoChatMode` is `Off | Suggest | Auto`, kebab-case,
  with Off as the default (`cohost.rs:636`). It is stored as
  `app_settings.cohostSettings.autoChat.mode`.
- **Off produces nothing.** Every lane entry point returns early on Off:
  `note_activity` (`cohost_auto_chat.rs:416`), `drain` (467),
  `route_answer` (731), `banter_allowed` (799) and `route_banter` (823).
- **`route` (`cohost_auto_chat.rs:337`) has only two outputs.** Auto pushes
  the utterance to `pass.send`, and Suggest pushes it to `pass.propose`.
  There is no automatic output that skips chat.
- **Automatic words reach the bubble only through chat.**
  - `apply_auto_chat_pass` (`cohost.rs:7342`) spawns `send_automatic` (7643)
    for each line in `pass.send`.
  - `send_automatic` gates on the mode at send time (D4 of plan 164).
  - It shows the bubble only after the send lands as `sent` (7826).
- **The Say box.** In Auto it sends. Otherwise it is `bubble-only`
  (`cohost_auto_chat.rs:863`, `cohost.rs:7949`, 7999).
- **The `bubble-only` status already exists on the wire** (`cohost.rs:716`).
  The Stream Manager's recent cards already render it
  (`buddy-utterance-cards.tsx:235`).

### The throttle

- `cohost_throttle.rs` is keyed by destination:
  - at most 6 sends a minute and at least 5 s apart;
  - a cooldown per kind, with bursts of more than 3 collapsing into one
    greeting;
  - one greeting per (destination, viewer, kind) a session.
- **Viewer keys aren't qualified by platform.** `viewer_key` is the raw
  `author_id` (`cohost_greetings.rs:379`). It was safe so far only because
  the destination already named the platform.

### Reactions

- A greeting template's reaction plays only when the mode isn't Off
  (`buddy_animator.rs:1105`).

### The bubble

- **One way in.** `buddy_overlay::show_bubble` (`buddy_overlay.rs:286`) is
  the only way a bubble appears. `show_for_utterance` (261) is the gate in
  front of it:
  - `utterance_bubbles` (251) passes `sent`, `bubble-only` and manual lines;
  - `overlay_enabled` (242) requires `showOnStream || showInRecording`.
- **A new bubble replaces the current one at once.** There is no queue, so
  a long answer can be cut off by a greeting 5 s later. Auto has this bug
  today.
- **Length limits.**
  - The bubble stays up `max(2.5 s, 60 ms × chars)`, at most 10 s (48).
  - `validate_say_text` (223) refuses anything over `BUDDY_SAY_MAX_CHARS` =
    200 (211). The bubble is then skipped with only a warn log.
  - Tick answers can be up to 2000 UTF-16 units (`cohost.rs:120`). A long
    Auto answer therefore reaches chat but never reaches the bubble.
  - The renderer wraps the bubble at 4 lines and ellipsizes the last one
    (`lib/buddy-overlay.ts:27`).
- **Answers don't carry the asker's name.** `AnswerCandidate` is built at
  `cohost.rs:3822` without it.

### The settings trap

- `load_cohost_settings` (`cohost.rs:1185`) falls back to defaults when the
  stored JSON doesn't parse. An older app that meets `"mode": "bubble"`
  would load defaults, and its next save would wipe the persona. This is the
  trap that plan 192 S1.1 avoided.
- A new struct field with a serde default is safe, because no Buddy settings
  struct uses `deny_unknown_fields`.

### The UI and the relay

- **The control.**
  - It lives in `stream-manager/buddy-chat-controls.tsx`, labelled
    `BUDDY_POSTING_LABEL` = "Chat posting" (`lib/buddy-auto-chat-view.ts:47`).
  - `BUDDY_MODES` (41) and `BUDDY_MODE_HINTS` (50) define the choices and
    the line under the control.
  - `buddyModeChangeStep` (122) shows the posting consent the first time the
    mode leaves Off, and a confirm for Auto every time.
- **The relay.**
  - `CohostAutoChatRelayPatch` is at `shared/backend.ts:7127`.
  - `main/index.ts:3318` validates `mode` against the literals
    `off | suggest | auto`.
  - `mergeAutoChatRelayPatch` (`lib/cohost-state.ts:83`) rebuilds the block
    from four named keys. **Any new key in `autoChat` is dropped there**
    unless it is added on purpose.
- **Other readers of the mode.**
  - `sayPostsToChat = live && mode === 'auto'` (`stream-manager.tsx:1096`).
  - The command palette keywords for Chat (`command-palette.tsx:92`).

### Takeovers in the compositor

- **One active takeover for both outputs.** The active takeover is
  `active_screen` on the compositor's scene snapshot (`compositor.rs:5117`).
  One `active_image_source` feeds both legs: primary at 8744, auxiliary at 8953.
- **Buddy always draws above a takeover today.** The CPU order is: scene,
  takeover, banners, captions, Buddy's pet, Buddy's bubble, highlight card
  (`render_compositor_yuv420p_frame`, `compositor.rs:9489`).
  - Metal does the same in `push_buddy_gpu_sources` (6999).
  - Windows D3D11 puts the pet at z 11 and the bubble at z 12
    (`windows_d3d11_session.rs:789-801`), and already knows
    `takeover_active` (837, 929).
- **The per-leg Buddy flags.**
  - The flags are `buddy_overlay_on_primary/aux` (`compositor.rs:651`), from
    `overlayLayout.buddy.{showOnStream, showInRecording}`.
  - They change mid-session through `update_overlay_flags` (668).
  - The pet and bubble inputs per leg are built at 8704 (primary) and 8909
    (auxiliary).
- **The layout setting.**
  - `OverlayItemLayout` (`overlay_layout.rs:95`) is shared by highlight,
    captions and buddy.
  - In TS, `OverlayLayout = Record<OverlayItem, OverlayItemLayout>`
    (`shared/backend.ts:5771`).
  - `overlays.layout.set` parses the whole layout (`main.rs:9574`).
  - `load_overlay_layout` (`overlay_layout.rs:689`) falls back to defaults on
    a parse error. The struct has no `deny_unknown_fields`.
- **Where the switches live.**
  - The one home of Buddy's output switches is the Layout → Buddy inspector
    (`OverlayItemInspector`, `layout-tab.tsx:1475`).
  - The Stream Manager footer mirrors only "{name} on stream"
    (`cohost-pane.tsx:848`).

### Reports and smokes

- **Reports.** `CohostSessionReport.posts[]` (`protocol.rs:5711`, capped at
  200 by `COHOST_REPORT_POSTS_CAP`) records chat sends only. Its result is
  `sent | partial | failed`. Bubble lines aren't recorded anywhere.
- **Smokes to extend.**
  - `smoke:buddy-pet` burns the Buddy into a real recording and reads the
    pet's colour tag per frame.
  - `smoke:live-chat-fake-providers` drives greetings through the fake
    providers (plan 192 Phase 5).

## Decisions (owner answers of 2026-10-26 folded in)

### Bubble mode

- **D1. One control with four values: Buddy talks: Off · Bubble · Suggest ·
  Auto.** The owner approved the label and the order.
  - **Bubble**: Greetings, Answers and Banter speak in the bubble only.
    Nothing ever goes to chat.
  - **Suggest and Auto don't change.** In Auto, a line still bubbles when it
    lands in chat.
  - **Off**: Buddy still says nothing on its own. The Say box still bubbles
    in Off, Bubble and Suggest, as it does today.
  - The order runs from least reach to most.
  - The label changes from "Chat posting" to "Buddy talks", with the
    persona's name when there is one ("Grum talks"), because Bubble isn't
    chat posting.
  - Rejected: a separate "Talk in the bubble" switch beside Chat posting. It
    splits one question across two controls and invents combinations (Suggest
    plus bubble) that have no clear meaning.
- **D2. Bubble needs no posting consent.**
  - Buddy posts nothing as the streamer, so `buddyModeChangeStep` returns
    `apply` for Bubble. Auto keeps its consent and its confirm.
  - AI lines (AI greetings, Answers, Banter) still need Premium and Cloud AI,
    exactly as today.
  - The promise "Buddy posts only in the modes you turn on. Everything is off
    by default." stays true word for word.
- **D3. Storage that older apps survive.**
  - A new field `autoChat.talk: "off" | "bubble" | "suggest" | "auto"` is the
    one truth for this and every later app.
  - The backend also writes `autoChat.mode`, as the projection older apps
    read: Bubble is saved as `off`. An older app on a Bubble profile is
    therefore quiet, which is the safe direction: it never posts what the
    streamer didn't choose.
  - On load: if `talk` is present it wins, and otherwise `talk` comes from
    `mode`. The renderer reads and writes only `talk`. Only the backend's
    normalization writes `mode`.
  - An older app that saves drops `talk`, because serde doesn't keep unknown
    fields. The next new app then reads `mode`. The two fields can't
    disagree for long.
- **D4. Bubble lines are paced for reading, not for chat limits.**
  - **Greetings.** In Bubble mode the throttle treats the bubble as one
    destination named `bubble`, shared by every platform. That keeps 6 lines
    a minute, 5 s apart, the kind cooldowns and the collapse ("Welcome Ada,
    Bo and 3 others!"). The dedupe key gets the platform
    (`"{platform}:{viewer_key}"`), because the destination no longer names
    it.
  - **Answers and Banter** skip the destination limiter in Bubble mode.
    Their own cooldowns (Answers 20 s, Banter 240 s) still hold. The bubble
    queue below stops any overlap.
  - **The bubble never cuts an automatic line short, in Bubble or Auto.**
    - A new automatic line waits for the current bubble to end, plus 0.5 s.
    - At most 3 lines wait, and a line that has waited 20 s is dropped. Both
      are counted as `stale` and logged once.
    - The streamer's own Say line still shows at once and replaces whatever
      is up. The queue resumes after it.
  - **Text that is too long gets clipped, not dropped.** Bubble text is
    trimmed to `BUDDY_SAY_MAX_CHARS` (200) at a word boundary with "…" before
    `show_bubble`. Today a long answer is silently not shown at all.
- **D5. Answers in the bubble say who they answer.**
  - With no chat thread, the bubble starts with "@{name} ", using the first
    asker's display name. It skips the prefix when the reply already
    contains the name, case-insensitively.
  - The chat path is unchanged.
- **D6. Bubble mode speaks only when someone can see it.** The owner chose
  to skip.
  - Buddy is visible when it is on an output (`overlay_enabled`) and isn't
    hidden by a takeover (D8).
  - When it isn't visible, greetings are skipped with a new reason,
    `no-bubble`. The skip is counted in the report and logged once per kind.
  - Answers aren't routed and Banter isn't requested, so no AI call is spent
    on a line nobody sees.
  - Not now: holding greetings while a takeover hides Buddy, then greeting
    everyone in one collapsed bubble when it ends ("Welcome back from the
    break, Ada, Bo and 12 others!"). It stays under Later.
  - Because the takeover switch starts off (D8), Bubble mode is quiet during
    takeovers by default. S-C2 makes the pane say so.
- **D7. Bubble mode spends no chat budget.**
  - Nothing is sent, so there are no YouTube quota calls, no destination
    limits and no failed-destination skips. No Buddy line ever appears as
    the streamer's chat message.
  - Chat must still be connected for reading, since greetings come from
    chat and Activity rows. A read-only destination is enough.
- **D8. The "Show on takeovers" switch.**
  - **Where**: Layout → Buddy inspector, as the third switch under Show on
    stream and Show in recording (the one-home rule from plan 174). The
    label is "Show on takeovers", and the description is "Keep {name} on
    screen while a takeover shows."
  - **Default**: off (owner answer 2), for new installs and existing users
    alike: a stored layout without the field reads as off. This changes
    today's behaviour, where Buddy always draws over takeovers, so the
    release notes say it in one line (S-A4).
  - **What it hides**: the whole Buddy (pet and bubble) on every output that
    carries it, for as long as any takeover shows. The two legs share one
    active takeover, so one switch covers both.
  - **Animation keeps running.** The animator and the sprite clock keep
    going while Buddy is hidden, so it comes back mid-idle instead of
    restarting. A bubble that was up stays up in state and simply isn't
    drawn.
  - **Storage**: `showOnTakeovers` on `OverlayItemLayout`, `#[serde(default)]`
    (false). Older apps ignore the field.
    - Highlight and captions carry it but don't honour it yet: their
      inspectors don't show it, and a code comment says so.
    - It goes on the shared struct because `OverlayLayout` is a
      `Record<OverlayItem, OverlayItemLayout>` in TS, and a sibling field
      would break that shape.
- **D9. Reports keep what Buddy said on stream.**
  - `CohostSessionReport.said[]` holds `{ id, at, trigger, text, source? }`.
    It records every `bubble-only` line, automatic or from the Say box.
  - It is oldest first, capped at 200 like `posts[]`, and omitted while
    empty, so older reports read unchanged.
  - `posts[]` stays chat-only.
  - Buddy → Reports shows a "Said on stream" block.

### What doesn't change

- **D10. Unchanged.**
  - Suggest and Auto routing, the chat throttle numbers, the consent dialog
    and the Auto confirm.
  - Premium and Cloud AI gating, the greet route and its daily cap, the
    built-in lines, the Buddy Live switch, and the "Say hi" nudge.
  - Buddy's lines never count as the streamer greeting anyone (plan 164
    D10).
  - The web isn't touched.
  - Reactions play in Bubble exactly as in Auto. That needs the animator gate
    at `buddy_animator.rs:1105` fixed.

## Phase A: "Show on takeovers" (desktop PR)

Evidence: `overlay_layout.rs:95`, `compositor.rs:651-690`, 8690-8770,
8909-8980, 9489-9530 and 6999, `windows_d3d11_session.rs:789-1013`, and
`layout-tab.tsx:1462-1530`.

### S-A1 Wire

1. Add `show_on_takeovers: bool` to `OverlayItemLayout` with
   `#[serde(default)]`. Add it to every `snapped_item` and `Default`, set to
   false.
2. In TS, add `showOnTakeovers: boolean` to `OverlayItemLayout`
   (`shared/backend.ts:5771`). Also update `backend-rpc-contract.ts`, the
   protocol fixtures, and every literal layout in tests.
3. Old-shape test: a 0.9.x layout JSON without the field parses with
   `showOnTakeovers: false`. A JSON with the field parses through a copy of
   the old struct (no field), which proves older apps survive it.
4. **Done when**: the round trip, the old-shape tests and the protocol
   contract test pass.

### S-A2 The compositor hides Buddy under a takeover

1. Add `buddy_on_takeovers: bool` to `CompositorLoopConfig`, the other
   config structs at `compositor.rs:555/618/651`, and `OverlayLegFlags`.
   Fill it wherever `buddy_on_primary/aux` are filled from the stored
   layout. `update_overlay_flags` swaps it mid-session.
2. Per composed frame, compute
   `buddy_hidden = active_image_source.is_some() && !buddy_on_takeovers`.
   When it is true:
   - `primary_buddy` and `aux_buddy` are `None`;
   - the `buddy_overlay` input of both legs is `None`.
3. Keep the sprite clock ticking (`state.buddy_sprite.clock_seconds`), so
   the animation doesn't jump when Buddy returns.
4. Gate at the inputs, not inside the renderers, so the CPU, Metal and
   `_with_chrome` paths all follow (9489, 9633, 7527, 7607, 7879).
5. Windows D3D11: `takeover_active` is already in the snapshot. Gate
   `buddy_on_primary/auxiliary` (`windows_d3d11_session.rs:1012`) and the
   sprite layer with it in the same way.
6. Add `buddy_overlay::buddy_visible(app) -> bool`, which is true when
   `overlay_enabled` holds and either `show_on_takeovers` is on or no
   takeover is active. It reads the compositor's `active_screen`. Phase B
   uses it for D6, and nothing else reads it in this phase.
7. Tests:
   - a CPU-path pixel test like
     `banners_draw_above_the_takeover_and_below_captions_and_the_card`
     (`compositor.rs:20613`). The pet and bubble are present over a takeover
     with the switch on, absent with it off, and present again with the
     switch off once the takeover clears;
   - the same three cases on Metal where a GPU is available;
   - a D3D11 unit test of the layer list on Windows CI.
8. **STOP** if the takeover and Buddy turn out to need different gating per
   leg, for example a simulcast leg with its own takeover. Report it; don't
   invent a per-leg switch.
9. **Done when**: the tests above pass on macOS and on the Windows CI job.

### S-A3 The switch

1. `OverlayItemInspector` shows a third `Field` + `Switch` for `buddy` only:
   - id `overlay-buddy-takeovers`;
   - label "Show on takeovers";
   - `FieldDescription`: "Keep {name} on screen while a takeover shows."
   - It is disabled with the same `blockedReason` as its siblings.
2. Widen the `onPatch` type with `showOnTakeovers`.
3. The Stream Manager footer doesn't get a second switch (one home).
4. **Done when**: a renderer test covers the switch's presence for buddy
   only and the patch it sends. The owner checks it by eye in light and
   dark.

### S-A4 Say the default change (D8)

1. The switch starts off for existing users too, so Buddy stops drawing over
   takeovers after the update. The PR description carries the public line
   for the next release's changelog (`changelog/<releaseId>.md`, written at
   release time by the `videorc-release` skill): "Buddy now steps aside
   while a takeover shows. To keep it on top, turn on Show on takeovers in
   Layout → Buddy."
2. Don't add a migration that flips the switch on for existing users. The
   owner chose off for everyone.
3. **Done when**: the line is in the PR description under "Release notes".

### Phase A gates (once, at the end)

- `cargo fmt --check --all`
- `cargo test -p videorc-backend overlay_layout compositor buddy`
- `cargo clippy -p videorc-backend -- -D warnings`
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- `pnpm --filter @videorc/desktop test`
- `pnpm test:scripts`
- `pnpm smoke:buddy-pet`, with the rows from S-D1 1 added in this phase
- `pnpm smoke:recording-studio`, because the change touches layout
  composition and recording output
- `pnpm smoke:recording-studio:devices` when the host has the permissions.
  Otherwise say why, and run the closest native-preview probe.
- The Windows CI job (D3D11 path)

## Phase B: Bubble mode in the engine (desktop PR)

Evidence: `cohost.rs:636-890`, 1185, 3822, 7257, 7342-7420, 7643-7840 and
7949-8000; `cohost_auto_chat.rs` (the whole file); `cohost_throttle.rs`;
`cohost_greetings.rs:379`; `buddy_overlay.rs:200-330`;
`buddy_animator.rs:1105`; `protocol.rs:5564-5600` and 5700-5715.

### S-B1 The `talk` wire (D3)

1. Add the enum
   `CohostTalkMode { Off, Bubble, Suggest, Auto }` (kebab-case).
2. Add `CohostAutoChat.talk: Option<CohostTalkMode>` with
   `#[serde(default, skip_serializing_if = "Option::is_none")]`.
3. `CohostSettings::normalized()` fills `talk` from `mode` when it is
   absent, then sets `mode = talk.legacy_mode()`: Bubble becomes Off, and
   the other three map to themselves.
4. Add the accessor `CohostAutoChat::talk() -> CohostTalkMode`. Every engine
   reader uses it.
5. `validated_patch` takes `talk`. A patch that carries only `mode` (an
   older relay) still works and sets `talk` from it.
6. Rename `auto_chat_mode()` (`cohost.rs:7257`) to `talk_mode()`.
7. In TS: add `CohostTalkMode`, and give `CohostAutoChat` a required
   `talk` (the backend always returns it). Update `backend-rpc-contract.ts`
   and the fixtures.
8. Relay: `CohostAutoChatRelayPatch` gains `talk?`.
   - `main/index.ts:3318` validates it against the four literals.
   - Keep `mode` accepted for one release and map it.
   - `mergeAutoChatRelayPatch` and `DEFAULT_COHOST_AUTO_CHAT` carry `talk`.
     **Trap**: the merge rebuilds the block from named keys, so a missing
     key is silently dropped.
9. Tests:
   - a round trip for each of the four values;
   - stored JSON with only `mode` loads the right `talk`;
   - the old-shape parse: Bubble JSON through a copy of today's
     `CohostAutoChat` (no `talk`) parses, with mode Off;
   - the relay validator refuses an unknown value;
   - the merge keeps `talk`.
10. **Done when**: all of the above pass.

### S-B2 The lane speaks in the bubble (D1, D7)

1. `AutoChatPass` gains `bubble: Vec<CohostUtterance>`, and `changed()`
   counts it.
2. `route()`: Bubble records the utterance as `BubbleOnly` and pushes it to
   `pass.bubble`. Auto and Suggest are unchanged.
3. Replace every `mode == Off` early return with `!talk.speaks()`. These are
   `note_activity`, `drain`, `apply_greet_result`, `route_answer`,
   `banter_allowed` and `route_banter`.
4. `say()`: Bubble behaves like Suggest (bubble-only).
5. `publish_auto_chat_pass` hands each `pass.bubble` utterance to the bubble
   queue (S-B3), then counts it like a send: it notes `last_auto_send_at`
   (Banter's quiet minute) and adds the line to the report (S-B6).
6. `send_automatic`'s mode gate refuses Bubble with "the chat mode does not
   allow it", so nothing can post even by mistake.
7. Fix the animator gate at `buddy_animator.rs:1105`: a template's reaction
   plays for Bubble too.
8. Bubble mode never applies the YouTube breaker or the destination checks
   (D7). Those live in the send path, which Bubble never enters.
9. **Invariant test**: `bubble_mode_never_sends`. It drives every lane entry
   (Activity rows, a welcome, a held burst through `drain`, an AI greet
   result, an answer, banter and Say) in Bubble mode. It asserts that every
   `pass.send` and `pass.propose` is empty and that every utterance is
   `bubble-only`. Also update the existing mode tests in
   `cohost_auto_chat.rs` (1161 onward) for the four values.
10. **Done when**: the invariant test and the updated tests pass.

### S-B3 Pacing and the bubble queue (D4)

1. Greetings in Bubble mode: before `offer_greeting`, rewrite
   `facts.destination_id` to `"bubble"` and `viewer_key` to
   `"{platform}:{viewer_key}"`. Collapse, dedupe and the kind cooldowns then
   work across platforms unchanged.
2. Answers in Bubble mode skip `throttle.admit` and `note_sent`, and need no
   `destination_id`. Today a missing row skips the answer. In Bubble mode
   the answer goes out anyway.
3. `buddy_overlay` gains a bounded queue in front of `show_bubble`, for
   automatic lines only:
   - When no bubble is up, the line shows now. Otherwise it waits until the
     current bubble's `until` plus 0.5 s.
   - At most 3 lines wait. A fourth line, or a line that has waited 20 s, is
     dropped, counted as `stale` and logged once per session.
   - Manual Say bypasses the queue and replaces whatever is up. The queue
     resumes after it.
   - The queue empties when the live-chat session changes.
   - It applies in Auto too: `send_automatic`'s bubble after landing goes
     through it.
4. Bubble text is clipped to `BUDDY_SAY_MAX_CHARS` at a word boundary with
   "…" before `validate_say_text`, so long answers show instead of
   vanishing. This also helps Auto.
5. Pure tests, clock-injected like the state machine:
   - a 10 s bubble isn't replaced by a line that arrives 5 s in;
   - the queue bound and the 20 s drop;
   - Say pre-empts and the queue resumes;
   - clipping at a word boundary.
6. **Done when**: those tests pass, and a burst of 5 first-timers on two
   platforms gives one collapsed bubble plus at most one follow-up.

### S-B4 Answers name the asker (D5)

1. `AnswerCandidate` gains `author_name: Option<String>`: the first
   asker's display name, from the same `known` map as `destination_id`
   (`cohost.rs:3818`).
2. In Bubble mode only, the text becomes `@{name} {text}`, unless the text
   already contains the name (case-insensitive). The result is clipped under
   S-B3 4.
3. **Done when**: tests cover the prefix, no double name, and no prefix in
   Auto or Suggest.

### S-B5 Only when visible (D6)

1. Before each lane pass, and before taking the engine lock, the engine
   computes `bubble_visible = buddy_overlay::buddy_visible(app)` (S-A2 6).
   It passes the value in next to `ai`.
2. In Bubble mode, when Buddy isn't visible:
   - greetings skip with `GreetingSkipReason::NoBubble` (wire `no-bubble`;
     log text "Buddy skipped a {kind} greeting (no-bubble): Buddy isn't on
     stream or is hidden by a takeover.");
   - `route_answer` returns nothing;
   - `banter_allowed` is false.
3. Report wire: `greetings.skipped.noBubble?` (omitted while zero) in Rust,
   TS and the contract.
4. **Done when**: tests cover all three, and show that no greet request is
   built while Buddy isn't visible.

### S-B6 Reports keep "said" (D9)

1. Add `CohostSessionReport.said: Vec<CohostReportSaid>` with
   `#[serde(default, skip_serializing_if = "Vec::is_empty")]`. The shape is
   `{ id, at, trigger, text, source? }`, oldest first and capped at 200
   (`COHOST_REPORT_SAID_CAP`).
2. Add `append_cohost_report_said` next to `append_cohost_report_post`.
3. Write the line when it actually shows, not when it is queued. A dropped
   queued line isn't "said".
4. Manual Say lines that are `bubble-only` are recorded too, with trigger
   `manual`.
5. Update TS and the contract.
6. **Done when**: a storage round trip passes, an old report without `said`
   reads unchanged, and the cap holds.

### Phase B gates (once, at the end)

- `cargo fmt --check --all`
- `cargo test -p videorc-backend cohost buddy_overlay buddy_animator`
- `cargo clippy -p videorc-backend -- -D warnings`
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- `pnpm --filter @videorc/desktop test` (the contract and relay tests)
- `pnpm test:scripts`
- `pnpm smoke:cohost-fake`
- `pnpm smoke:live-chat-fake-providers`, so Auto and Suggest still behave as
  plan 192 left them
- `pnpm smoke:youtube-quota`, because automatic YouTube sends share the
  breaker and Auto's path changed (the bubble queue)

## Phase C: Bubble mode in the UI (desktop PR)

Read `.claude/skills/videorc-design/SKILL.md` first. Use shadcn components
only.

### S-C1 The control

1. In `lib/buddy-auto-chat-view.ts`:
   - `BUDDY_MODES` becomes `BUDDY_TALK_MODES`, in the order
     `['off', 'bubble', 'suggest', 'auto']`;
   - the labels are Off, Bubble, Suggest and Auto;
   - `BUDDY_POSTING_LABEL` becomes `buddyTalkLabel(name)`: "{name} talks",
     falling back to "Buddy talks";
   - the hints:
     - off: "{name} says nothing on its own."
     - bubble: "{name} talks on stream in its bubble. Nothing goes to chat."
     - suggest: "Each message is a card here; one click sends it to chat."
     - auto: "Messages go to chat and the bubble by themselves, within the
       limits."
   - The owner approved the label and the order. The hints are the owner's
     to change at the by-eye check.
2. `buddyModeChangeStep` returns `apply` for `bubble` (D2). Off and Bubble
   never open the consent dialog.
3. `buddy-chat-controls.tsx` uses the four values on the same
   `SegmentedControl` (`size="sm"`). It must still fit the pane at its
   narrowest width. **STOP** if it doesn't: report it, and propose a
   `Select` fallback only for the narrow container query.
4. In the pane, the behaviour chips group's accessible name changes from
   "What Buddy posts" to "What Buddy says".
5. `sayPostsToChat` reads `talk === 'auto'` (`stream-manager.tsx:1096`).
6. The command palette keywords for Chat (`command-palette.tsx:92`) add
   `bubble`.
7. **Done when**:
   - unit tests cover the four values, the change steps and the relay patch
     the control sends;
   - the owner checks it by eye at the pane's narrowest and widest, in light
     and dark.

### S-C2 Saying when the bubble can't be seen (D6)

1. In Bubble mode while on air, when Buddy is on no output, the existing
   `buddyOffOutputsNotice` already shows. Its detail line becomes "Viewers
   can't see it or its bubble, so Bubble mode says nothing." Only the copy
   for Bubble changes.
2. In Bubble mode while a takeover hides Buddy (switch off and a takeover
   active), a quiet line under the hint says "{name} is hidden while the
   takeover shows. Change it in Layout → Buddy." With the switch off by
   default (D8), this is the common case during a takeover, so the line must
   be there. It has no switch of its own (one home).
   Studio holds the active takeover (`activeScreen`,
   `use-studio.tsx:2555`), but the Stream Manager is another window. It gets
   Buddy's fields through the Studio relay, the same way it gets
   `showOnStream`. Add one derived `hiddenByTakeover` boolean to that relay.
   Don't add a second subscription.
3. **Done when**: pure tests cover both decisions, and the owner checks them
   by eye.

### S-C3 Copy audit

1. Read `buddy-greetings-section.tsx`, `cohost-settings-section.tsx`,
   `buddy-tab.tsx` and the Buddy → Chat tab for words that assume chat
   ("posts", "in chat") where Bubble also applies. Say "says" where the line
   may go to the bubble.
2. Hide or explain the X 140 cap warnings only where they can't apply. They
   still apply to Suggest and Auto.
3. Keep `BUDDY_POSTS_PROMISE` word for word (D2).
4. **Done when**: the owner checks the audited copy by eye. Record the list
   of changed strings in the PR.

### S-C4 Reports

1. `buddy-report-card.tsx` gets a "Said on stream" block from `said[]`:
   time, trigger and text, in the same row style as posts.
2. Show it only when `said[]` isn't empty.
3. `greetings.skipped.noBubble` joins the skip lines: "{n} not said: {name}
   wasn't on stream".
4. **Done when**: tests cover the report card and the library report, and
   the owner checks them by eye.

### Phase C gates (once, at the end)

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- `pnpm --filter @videorc/desktop test`
- `pnpm build`
- A light and dark by-eye pass of the Stream Manager Buddy pane, Layout →
  Buddy and Buddy → Reports

## Phase D: Smokes and live acceptance (desktop PR)

### S-D1 Smokes

1. Extend `smoke:buddy-pet` (lands with Phase A):
   - activate a takeover with "Show on takeovers" at its default (off), and
     expect no pet tag and no bubble pixels on the takeover frames;
   - turn it on mid-session, and expect the pet's tag on the takeover frames
     within one second;
   - turn it off again, clear the takeover, and expect the pet back within
     one second.
2. Extend `smoke:live-chat-fake-providers` (Phase B):
   - Bubble mode with a fake follow, a first-time chatter and a burst of 4
     welcomes across two providers;
   - assert `cohost.buddy.state` bubbles for each greeting (collapsed for
     the burst);
   - assert **zero** `liveChat.send` or fake-provider sends, and `said[]` in
     the report;
   - assert Auto still sends.
   - Update the fake-activity totals in the probe test.
3. **Done when**: both smokes pass twice in a row.

### S-D2 The owner's live acceptance

1. On the owner's own channels:
   - Bubble mode for 15 minutes;
   - then a "Be right back" takeover with Show on takeovers off (the
     default) for 2 minutes;
   - then the same with it on for 2 minutes.
2. Record it in
   `docs/acceptance/2026-xx-xx-buddy-talks-in-its-bubble.md`:
   - every bubble line (Buddy → Reports, "Said on stream");
   - whether any line went to chat (it must not);
   - how bursts read on stream;
   - whether answers were clear with "@name";
   - how Buddy looked over and without the takeover, in both the stream and
     the recording.

## Out of scope

- A per-takeover switch (show Buddy on "Starting soon" but not on
  "Technical difficulties"). See Later.
- "Show on takeovers" for captions and the highlight card.
- Bubble now plus Suggest chat cards in the same mode.
- Telling the web greet and tick routes that the line is for a bubble
  (shorter, more playful lines). The routes stay as they are.
- Voice output (TTS) for Buddy.
- Remembering regulars (plan 183, parked).

## Later

1. Per-takeover "Show Buddy" overrides, with the global switch as the
   default.
2. D6's alternative: hold greetings while a takeover hides Buddy, then
   greet everyone in one collapsed bubble when it ends.
3. `surface: 'bubble'` on greet and tick requests, so the web writes for the
   bubble.

## Owner answers (2026-10-26)

1. **D1**: "Buddy talks: Off · Bubble · Suggest · Auto", with the Buddy's
   name: approved ("that is good").
2. **D8**: "Show on takeovers" starts off ("it can start off"). This was
   against the recommendation, so the plan now carries the release note
   (S-A4) and the pane line (S-C2).
3. **D6**: while a takeover hides Buddy in Bubble mode, greetings are
   skipped ("skip"). Holding them stays under Later.
