# Plan 192: Buddy greets and talks on its own

> **Executor instructions**: Work one phase at a time, in order. Each phase is
> one PR (Phase 2 is a web PR plus a desktop PR). Read the phase's evidence
> first, run its "Done when" checks, and stop and report on any STOP
> condition instead of improvising. When a phase lands, update its row in
> the Status table and in `plans/README.md`.
>
> **Drift check (run first, every phase)**:
> `git log --oneline 67c12b8c..origin/main -- crates/videorc-backend/src/cohost*.rs crates/videorc-backend/src/live_chat.rs apps/desktop/src/renderer/src/lib/buddy-auto-chat-view.ts apps/desktop/src/renderer/src/components/buddy-greetings-section.tsx`
> and, for web work, `git -C ~/projects/videorcweb log --oneline 9048a4de..origin/main -- lib/ai/cohost*.ts app/api/ai/cohost`.
> Line numbers were read at desktop `67c12b8c` (0.9.150) and web `9048a4de`.
> If an anchor moved, find it again by symbol. If the _behaviour_ changed,
> stop and report.

## Status

| Phase | What                                                             | PR                              | State                               |
| ----- | ---------------------------------------------------------------- | ------------------------------- | ----------------------------------- |
| 0     | Greetings work with no setup: built-in lines, honest diagnostics | desktop PR                      | BUILT                               |
| 1     | Welcome first-time and returning chatters                        | desktop PR                      | BUILT                               |
| 2     | AI writes every greeting in Buddy's voice (Premium)              | web #93 `0cdf2bf5` + desktop PR | BUILT                               |
| 3     | Answers as planned: unanswered questions too, clear defaults     | desktop PR                      | BUILT                               |
| 4     | Tick reliability: the 502s                                       | web #92 `67e6d87f`              | MERGED, next-stream check owed      |
| 5     | Smokes and live acceptance                                       | desktop PR                      | Smoke written; live acceptance owed |

**Owner answers (2026-10-24)**: every recommendation taken (D2 both
welcomes on, D3 AI writes all greetings, D5 notes-only Answers with Answers
on by default, the 500/day cap). The owner added: "have some default
answers before someone actually puts it, something simple like 'hi'. I had
no clue that I have to put my answers there." So the built-in lines below
are short and plain, and an empty list never means silence. Execute the whole
plan; one desktop PR and one web PR.

**As built (2026-10-24)**: web #93 (greet route) and #92 (Phase 4: the
tick's backup model starts at 3 s instead of 6 s) merged. Production logs
for the 10-24 stream showed the primary timing out on 57 of 219 ticks and
the backup, started too late behind the judge, failing 21 of them. The
desktop work is one PR. Deviations: an AI-greeting smoke cannot run end to
end (Premium is a signed entitlement a smoke cannot fake), so the AI path
is covered by engine tests with a fake greet client and a wire test;
`held` greetings are reported apart from the ones never posted, because
they go out later.

- **Priority**: P1. The owner streamed on 0.9.150 on 2026-10-24 with Buddy
  in Auto, and Buddy posted nothing on its own.
- **Effort**: Phases 0 and 1 are M each. Phase 2 is L (web route plus
  desktop lane). Phases 3 and 4 are M. Phase 5 is S plus the owner's live
  stream.
- **Risk**: MEDIUM. Buddy posts as the streamer's own account (plan 164 D3),
  so a bad line goes out under the owner's name. Every phase keeps the plan
  164 throttle (D9), the Off/Suggest/Auto mode (D4) and the consent dialog.
- **Depends on**: none. Plan 183 (Buddy remembers your regulars) is parked;
  this plan doesn't need it, and nothing here blocks it.
- **Route**: Orchestrator owns it (fit 10). Phases 0, 2, 3 and 4 are
  `fable-5` (behaviour that posts as the streamer, a new web route, a
  diagnosis). The greetings editor UI in Phase 1 is `opus-4.8` with the
  `videorc-design` skill. Phase 5 is `gpt-5.5`.

## What the owner saw

"Buddy works on my live stream, but only when I drive it by hand. It should
use AI to greet the guests and say hi to people chatting for the first time.
It doesn't seem to use AI at all."

## Diagnosis (2026-10-24, from the owner's own data)

The owner's saved settings (`app_settings.cohostSettings`, last changed
2026-10-16):

```json
"autoChat": {
  "mode": "auto",
  "greetings": { "enabled": true, "templates": [] },
  "answers":   { "enabled": false, "cooldownSeconds": 20 },
  "banter":    { "enabled": false, "cooldownSeconds": 240 }
}
```

Today's stream (16:20–17:43Z, 219 Buddy ticks) and its Buddy report
(`cohost_reports`, session `f0a20bbf…`) show:

- `posts[]` holds only two lines, both `trigger: manual`: "hello" and
  "heeeey" (the owner's Say box). No automatic post at all.
- The owner greeted 11 chatters by voice ("X was greeted on stream N s after
  their first message"), 4 of them first-time-in-the-channel. That took
  between 3 s and 380 s. Buddy did none of it.
- 21 of 219 ticks failed with `gateway-error` HTTP 502, "failed on every
  configured model" (about 10%, bunched around ticks 149–172). The web's
  backup model from #90 didn't save them.

Five causes. Each one is enough on its own to keep Buddy quiet:

1. **Greetings has no lines, so it posts nothing.**
   `cohost_auto_chat.rs:207` returns early when `templates.is_empty()`. The
   starter set is opt-in: the owner must click "Add the starter set" in
   Buddy → Chat (`buddy-greetings-section.tsx:133`). Stream Manager shows the
   warning chip "Greetings on, no lines", but it's easy to miss. No log line
   says that a follow was skipped.
2. **First-time chatters are never greeted automatically.** Greetings answer
   Activity rows only (follow, sub, cheer, raid and so on).
   `cohost_greetings.rs::activity_facts` returns `None` for plain chat, and
   `CohostActivityTemplateKind` (`cohost.rs:643`) has no first-chat kind.
   `live_chat.rs:3232` already marks `first_message` (new to the channel,
   from local history). Only the "Say hi" nudge reads it (plan 068 D9,
   `cohost_ack.rs`), and that nudge asks the _streamer_ to greet.
3. **Greetings never use AI, by design.** Plan 164 D5 made Greetings
   "templates written by the user, no AI", and Greetings stay free (D6). The
   persona's personality ("Loud, loyal and proud of the horde. Cheers every
   follower like a battle won…") reaches the model only through tick v4,
   which only writes question replies and banter.
4. **The AI behaviours are off, and narrower than planned.** Answers and
   Banter default to `enabled: false` (`cohost.rs:790`). Even when on, an
   Answer goes out only for a NEW question with `addressed: true`, meaning a
   viewer typed the persona's name ("Golmar") or `@Golmar`
   (`cohost.rs:3677`). Viewers don't know that name. Plan 164 D5 also
   promised replies to "a question that targets the stream and nobody
   answered". S-D3 deferred that half ("question replies stay suggestions
   only ⚑, safer first ship"), and nothing picked it up. Banter needs 20 s of
   microphone silence (`cohost_ack::banter_due`). The owner talks all the
   time, so Banter would rarely fire even when on.
5. **Ticks fail about 10% of the time.** Answers and Banter ride the tick, so
   those failures drop them too.

So "not affected by AI in any way" is accurate for this configuration. The
one automatic behaviour that is on has nothing to say. The AI behaviours are
off. And the behaviour the owner expects most, welcoming new chatters in
Buddy's own voice, was never built.

## Decisions

Each ⚑ needs the owner's answer before its phase starts. The recommended
option comes first.

- **D1. Greetings work with no setup.** Rust carries one built-in line for
  every greeting kind (the plan 164 starter set, plus lines for the kinds it
  lacks). A kind with no template from the user uses the built-in line. A
  kind whose templates the user has all switched off is off. An empty list
  never means silence again.
- **D2 ⚑. Who Buddy welcomes.**
  - **First-time chatters**: the author's first message ever in the channel,
    by Videorc's local history (`first_message`). On by default.
  - **Returning chatters**: the first message this stream from someone who
    chatted on an earlier stream. Recommended: on by default, with a
    "welcome back" line. Alternative: off by default.

  Today's stream had 4 + 7, so 11 greetings in 80 minutes, well under the
  6-per-minute cap.

- **D3 ⚑. AI writes the greetings (Premium).** With Premium and AI consent,
  Buddy writes each greeting itself, in the persona's voice. It reacts to the
  viewer's first message lightly and never answers questions or invents
  facts. Without Premium or consent, or when the AI call fails or takes more
  than 3 s, the template line goes out instead. A greeting is never lost to
  an AI failure. The user's own line for a kind becomes the style example the
  model follows. A new setting, `greetings.ai`, is on by default. The
  alternative is AI for welcomes only, keeping fixed lines for follows and
  subs.
- **D4. AI greetings use their own small route, not the tick.** Ticks run
  every ~22 s with a p50 of ~7 s, so a greeting through the tick would land
  10–30 s late and fail 10% of the time. A new `/api/ai/cohost/greet` route
  copies `/api/ai/cohost/spotlight`: synchronous, Premium-gated,
  consent-gated, metered per day as `cohost-greet` usage events, with a fast
  model and a 3 s budget. Desktop calls it only when
  `/api/ai/cohost/capabilities` reports `greet: 1`.
- **D5 ⚑. Answers do what plan 164 D5 promised.**
  - Keep: answer a question addressed to Buddy by name.
  - Add: a question to the stream that nobody answered within 60 s gets a
    reply only when the streamer notes answer it (`fromNotes: true`).
    Otherwise it stays a card for the streamer.
  - Recommended: Answers on by default for Premium on new installs. Saved
    settings are never flipped silently.
  - Alternative: answer any unanswered question in character ("the streamer
    will get to that").
- **D6. Buddy introduces itself once per stream.** Viewers can't address a
  name they don't know. The first AI greeting each stream may add that you
  can ask Buddy by name. The prompt asks for it at most once; the lane
  enforces nothing more.
- **D7. Every skip is visible.** When Buddy doesn't greet, the reason goes to
  the backend log once per kind per session: no line, the mode, throttle
  hold, dedupe, a failed destination, or the YouTube breaker. The session
  report gains `greetings.skipped` counts. Stream Manager chips say what will
  actually happen, for example "Greetings on · AI" or "Greetings on · lines".
- **D8. Unchanged.** Buddy still posts as the streamer's own account (164
  D3). The throttle, the per-session dedupe, collapse and the YouTube budget
  stay as they are (164 D9). Buddy's posts never count as the streamer
  greeting or replying (164 D10), so the "Say hi" nudge for an on-air hello
  stays.

## Execution contract (pinned 2026-10-24, shared by every executor)

### Built-in lines (owner: "something simple like hi")

`{name}` in a collapsed batch resolves to the names list ("Ana, Bo and
4 others"), so a line written with `{name}` never greets only the first
viewer of a burst. Built-in lines use only `{name}`, so they read right
whatever optional fields a platform leaves empty.

| Kind (wire)            | Built-in line                                | State |
| ---------------------- | -------------------------------------------- | ----- |
| `first-time` (welcome) | `Hi {name}, welcome to the stream!`          | talk  |
| `returning` (welcome)  | `Welcome back, {name}!`                      | talk  |
| `follow`               | `Welcome, {name}! Thanks for the follow.`    | talk  |
| `sub`                  | `{name} joined the ranks. Thank you!`        | laugh |
| `resub`                | `{name} is back in the ranks. Thank you!`    | laugh |
| `sub-gift`             | `Thanks for the gift sub, {name}!`           | laugh |
| `community-sub-gift`   | `{name} gifted subs to the chat. Thank you!` | laugh |
| `membership`           | `Welcome to the members, {name}!`            | laugh |
| `cheer`                | `Thanks for the bits, {name}!`               | talk  |
| `kicks`                | `Thanks for the Kicks, {name}!`              | talk  |
| `super-chat`           | `Thanks for the Super Chat, {name}!`         | talk  |
| `super-sticker`        | `Thanks for the Super Sticker, {name}!`      | talk  |
| `raid`                 | `{name} is raiding! Welcome, everyone!`      | laugh |
| `watch-streak`         | `{name}, thanks for the watch streak!`       | talk  |
| `power-up`             | `Thanks for the power-up, {name}!`           | talk  |
| `redemption`           | `Thanks for redeeming, {name}!`              | talk  |

The rows live in one fixture,
`protocol-fixtures/buddy-builtin-greetings.json`, that the
Rust tests (`include_str!`) and the TS tests both read. Rust holds the
runtime copy as a const table; a test asserts it equals the fixture. TS holds
`BUDDY_BUILTIN_GREETINGS` and asserts the same.

### Settings wire (cohostSettings.autoChat.greetings)

```jsonc
{
  "enabled": true, // Default impl now true (mode Off still posts nothing)
  "templates": [], // unchanged; an empty list = built-in lines
  "ai": true, // NEW, serde default true; honoured only with Premium + consent + capability
  "welcomes": {
    // NEW, serde default; never inside templates[] (old-app trap, S1.1)
    "firstTime": { "enabled": true }, // text absent = built-in line
    "returning": { "enabled": true, "text": "Yo {name}!", "state": "talk", "reaction": "wave" }
  }
}
```

`WelcomeLine`: `enabled` (serde default true), `text?` (absent, never null;
at most 200 UTF-16 units, trimmed; empty = absent), `state` (serde default
`talk`), `reaction?` (absent, never null). Every `Option` uses
`#[serde(default, skip_serializing_if = "Option::is_none")]` (serde null
trap). `answers` default becomes `{ enabled: true, cooldownSeconds: 20 }`
(applies only when the stored block lacks `answers`; saved values stay).

Report wire: `CohostSessionReport.greetings.skipped?: { noLine?, modeOff?,
stale?, deduped?, held?, destinationFailed?, youtubePaused? }` (omitted while
all zero; each key omitted while zero) and `posts[].source?: 'ai' | 'line'`
(omitted on manual, answer and banter posts and on old rows). Every new
field goes into `backend-rpc-contract.ts` (strict-contract trap).

### Greet route wire (web `POST /api/ai/cohost/greet`, desktop client)

Request (zod strict, at most 16 KB):

```jsonc
{
  "clientVersion": "0.9.151",
  "consentToProcessChat": true,
  "sessionClientId": "…",        // the live-chat session id
  "seq": 3,
  "tone": "short",               // COHOST_TONES
  "persona": { "name": "Golmar", "personality": "…" } | null,
  "introduce": true,             // first AI greeting of the session only
  "items": [                     // 1..6
    {
      "id": "g-3",               // unique in the request, at most 80
      "kind": "first-time",      // the 16 kinds above
      "platform": "twitch",      // COHOST_PLATFORMS
      "names": ["Ana", "Bo"],    // 1..3, each at most 120
      "others": 4,               // 0.. (the "and N others")
      "months": 12, "streak": 5, "count": 500, "amount": "$5.00", "reward": "Hydrate", // optional
      "firstMessageText": "hey!", // optional, at most 200, welcomes only
      "fallbackLine": "Hi Ana, welcome to the stream!" // the resolved line; the style example
    }
  ]
}
```

Response 200: `{ "lines": [{ "id": "g-3", "text": "…", "mood": "neutral" |
"amused" | "thinking" }], "model": "…" }`. A missing id means "use the
fallback". Errors use the spotlight route's codes and shapes (401
unauthenticated, 403 premium-required / consent-required / disabled, 429
daily cap, 400 invalid request, 502/504 model failure). Usage kind
`cohost-greet`, one event per request with `items.length`. Daily cap
`VIDEORC_AI_COHOST_GREET_DAILY_LIMIT`, default 500 requests. Capabilities
gain `greet: 1` (number, like `tick`); `0` when the route is switched off
(`VIDEORC_AI_COHOST_GREET_DISABLED=true`) or Buddy is off for the user.

Desktop: a 403 (premium, consent, disabled) stops AI greets for the rest of
the live-chat session; anything else falls back for that batch only. The
client timeout is 3.5 s (the server budget is 3 s).

## Phase 0: Greetings work with no setup (desktop, free)

Evidence: `cohost_auto_chat.rs:194-235` (`note_activity`),
`cohost_greetings.rs:200` (`pick_template`),
`buddy-auto-chat-view.ts:78-100` (chips) and `:250` (starter set).

### S0.1 Built-in lines in Rust

1. Add `cohost_greetings::builtin_template(kind) -> CohostGreetingTemplate`.
   It covers every `CohostActivityTemplateKind`, using the starter set's
   words where they exist. Write new lines for sub-gift, community gift,
   membership, kicks, Super Chat, Super Sticker, power-up and redemption,
   with only the fields each kind has (the `BUDDY_SAMPLE_FIELDS` table). Keep
   the TS `BUDDY_STARTER_TEMPLATES` as a mirror and add a shared fixture
   that both test suites read, so the two lists can't drift.
2. `pick_template` resolves in this order: the user's enabled templates for
   the kind and platform, then the built-in line when the user has no
   template of that kind, then off when every template of that kind is
   switched off.
3. Remove the `templates.is_empty()` early return (`cohost_auto_chat.rs:207`).
4. **Done when**: `cargo test -p videorc-backend cohost_greetings
cohost_auto_chat` passes with new tests: an empty list greets a follow in
   Auto; an all-disabled kind stays silent; a user line beats the built-in
   line.

### S0.2 Skips are logged and counted (D7)

1. `AutoChatPass.log` gets one line per (kind, reason) per session for these
   reasons: `no-line`, `mode-off`, `stale`, `deduped`, `held`,
   `destination-failed` and `youtube-paused`.
2. `CohostSessionReport.greetings` gains `skipped: { [reason]: count }`.
   Leave it out while empty, and add it to `backend-rpc-contract.ts` and the
   contract fixtures (strict-contract trap: a new field the contract doesn't
   know retires main's pump).
3. The chips in `buddyBehaviourChips` drop the "no lines" warning (it can't
   happen any more) and say "Greetings on", or "Greetings on · AI" after
   Phase 2.
4. **Done when**: the engine tests assert the log lines; `pnpm --filter
@videorc/desktop test -- buddy-auto-chat-view protocol-contract` passes.

### S0.3 Editor shows the built-in lines

1. In Buddy → Chat → Greetings, a kind with no user template shows its
   built-in line as a "Default" row. Editing the row creates a user
   template; switching it off creates a disabled template. "Add the starter
   set" goes away. Follow the `videorc-design` skill and check both themes.
2. **Done when**: the renderer test for `buddy-greetings-section` covers the
   default rows. Do the by-eye check in light and dark.

## Phase 1: Welcome first-time and returning chatters (desktop, free)

Evidence: `live_chat.rs:3205-3245` (the `fresh` set and `first_message`),
`cohost.rs:9480-9500` (every delivered message already reaches
`note_activity`) and `cohost_throttle.rs`.

### S1.1 Two welcome kinds without breaking older apps

**Trap**: `load_cohost_settings` (`cohost.rs:1068`) falls back to _defaults_
when the stored JSON doesn't parse. An older app that meets an unknown
`kind` in `templates[]` would load defaults, and its next save would wipe
the persona. So the new kinds never go into `templates[]`.

1. Add `CohostGreetingsSettings.welcomes: { firstTime: WelcomeLine,
returning: WelcomeLine }`, where `WelcomeLine = { enabled, text?, state?,
reaction? }` and every field uses `#[serde(default)]`. Older apps ignore
   the field: no `deny_unknown_fields` exists on these structs; check that
   with a test that parses the new JSON through the 0.9.150 struct shape.
   Update the TS types, `backend-rpc-contract.ts` and the fixtures.
2. The built-in lines are first-time "Welcome to the stream, {name}!" and
   returning "Welcome back, {name}!". Owner copy ⚑.
3. **Done when**: a round-trip test, the old-shape parse test, and the
   protocol-contract test all pass.

### S1.2 The lane welcomes chatters

1. Add `first_in_session: bool` to `LiveChatMessage` with `#[serde(skip)]`,
   so it never crosses the wire. Set it from the `fresh` set in
   `live_chat.rs` beside `first_message`.
2. Add `cohost_greetings::welcome_facts(message)`, which returns facts for a
   plain chat row when `first_message` is set (first-time) or when
   `first_in_session && !first_message` (returning). It skips:
   - the streamer's own account (`counts_as_chatter`);
   - known bots (Nightbot, StreamElements, Streamlabs, Moobot, Fossabot,
     Sery_Bot), as a const list with a test;
   - deleted rows;
   - names that contain a URL;
   - messages the moderation lane flagged.
3. Welcomes go through the same `offer_greeting` throttle with two new kind
   cooldowns, first-time 5 s and returning 10 s. Collapse works as before
   ("Welcome Ana, Bo and 4 others"). The welcome goes only to the destination
   the message came from (164 D8).
4. **Done when**: engine tests cover a first-timer greeted once; a returning
   chatter greeted once per session; a second message not greeted; a bot
   skipped; a burst of 5 collapsed; Off mode silent; and Suggest giving a
   card.

### S1.3 Editor rows

1. Add a "Welcomes" group above the activity kinds in Buddy → Chat →
   Greetings, with rows for first-time and returning. Each row has its
   switch and an editable line, and the fields are `{name}`, `{handle}` and
   `{platform}`. Use the design skill and check both themes.
2. **Done when**: the renderer tests pass. Do the by-eye check in light and
   dark.

## Phase 2: AI writes every greeting in Buddy's voice (web, then desktop, Premium)

Deploy the web first. Desktop calls the route only when the capabilities
report it.

### S2.1 Web: `/api/ai/cohost/greet` (videorcweb)

1. Copy the spotlight trio: `app/api/ai/cohost/greet/route.ts`,
   `lib/ai/cohost-greet-route.ts` and `lib/ai/cohost-greet.ts`. Gate it on
   Premium and consent, add the `AI_USAGE_EVENT_KIND_COHOST_GREET` usage
   kind, and set a daily cap (⚑ number; start with 500 a day).
2. Request:
   ```ts
   {
     persona: { name, personality } | null,
     tone,
     items: [{
       id,
       kind,
       platform,
       name,
       handle,
       months?,
       streak?,
       count?,
       amount?,
       reward?,
       firstMessageText?,
       styleExample?,
     }],
     introduce: boolean,
   }
   ```
   `items` holds at most 6, `firstMessageText` at most 200 chars, and
   `styleExample` is the user's line for that kind.
3. Response: `{ lines: [{ id, text, mood }] }`. Each text is at most 200
   UTF-16 units and is one line.
4. The prompt treats `personality`, names and message text as untrusted data
   (the same wording as `COHOST_PERSONA_IDENTITY`). It speaks as the
   character, never as the streamer. It never answers questions or invents
   facts. When `introduce` is true it may say once that viewers can ask
   `persona.name`.
5. The server validates every line: no URLs, no newline, and no @mention
   other than the item's handle. It drops a line that fails, and the desktop
   then falls back to the template.
6. Use a fast model with a 3 s budget (`COHOST_GREET_BUDGET_MS`). Read
   `MIN_COHOST_ATTEMPT_MS` and the #90 backup pattern; pick the model from
   the `cohost.ts` ladder or use Jev like spotlight, and write down the pick
   and its p50 from a probe.
7. Capabilities report `greet: 1`.
8. **Done when**: the web unit tests cover the gates, the validator and the
   schema, and `pnpm lint` and `pnpm test` pass in videorcweb. Deploy to
   prod; `/api/ai/cohost/capabilities` shows `greet: 1`.

### S2.2 Desktop: the lane asks the AI first

1. Add `greetings.ai: bool` (serde default `true`, so it's honoured only
   with Premium and consent), the TS type and the contract.
2. When a batch is ready (`SendNow`, or a drained bucket), the lane checks
   Premium (`cohostGate`), `aiConsent`, the capability `greet >= 1` and
   `greetings.ai`. When all four hold, it releases the engine lock and
   calls the greet route with a 3 s timeout. On success the AI text replaces
   the template text and the mood sets the state through
   `utterance_state_for_mood`. On any failure the template line goes out,
   and the log says why. Never hold `state.cohost` across the await.
3. `introduce` is true for the first AI greeting of the session only.
4. Report `posts[].source: 'ai' | 'line'`. Leave it out for old rows, and
   add it to the contract.
5. Suggest mode shows the AI text on the card.
6. **Done when**: engine tests with a fake greet client cover AI text used;
   timeout falling back to the line; no Premium never calling;
   `introduce` only once; and no engine lock across the call (the existing
   lock-order test pattern). `cargo clippy -p videorc-backend -- -D
warnings` passes.

## Phase 3: Answers as planned (desktop only)

The tick already returns `fromNotes` and `suggestedReply` for every open
question, and the desktop knows when each question was asked, so this rule
needs no web change.

1. An open question becomes an Answer candidate when either
   - it's addressed (as now, `cohost.rs:3677`); or
   - it has been open for 60 s or more, the streamer hasn't answered it in
     chat or on air (the `cohost_ack` ledger: own send delivered, or
     "answered on air"), its `suggestedReply` is non-empty and `fromNotes`
     is true.

   Each question becomes a candidate once. The same Answers cooldown and
   throttle apply.

2. **Defaults (D5)**: a new install with Premium gets `answers.enabled:
true`. Saved settings are never changed.
3. **Done when**: engine tests cover an unaddressed question answered only
   from the notes after 60 s; a question the streamer answered never
   answered by Buddy; and the default true only when `cohostSettings` was
   never stored.

## Phase 4: Tick reliability (diagnose first, web)

1. Read the prod Vercel logs for 2026-10-24 16:20–17:43Z (the owner allows
   prod log reads: `npx vercel@latest logs -e production --since …`). Find
   which model failed, how fast, and whether the #90 backup started.
   Compare with the 10-21 evidence (22/22 failures were single 9 s timeouts).
2. Fix what the logs show: a primary cap, a different backup, or the
   gateway's own 502s.
3. **Done when**: a before-and-after failure rate on a replayed tick load,
   or the next stream's log, shows under 2% failed ticks. STOP if the logs
   show the gateway itself failing; report to the owner.

## Phase 5: Smokes and live acceptance

1. `smoke:live-chat-fake-providers` gains rows for a follow with an empty
   list (built-in line), a first-time chatter, a returning chatter, and an
   AI greeting through a fake greet route, with fallback on its timeout.
   Update the fake-activity totals in the probe test.
2. Owner live acceptance on their own channels: Suggest for 10 minutes, then
   Auto for 20. Record it in
   `docs/acceptance/2026-xx-xx-buddy-greets-on-its-own.md`. Note every
   automatic post (Buddy → Reports), whether it read like Golmar, any line
   the owner would not have sent, and the throttle behaviour under a raid.

## Gates (once, at the end of each phase; see `AGENTS.md`)

- `cargo fmt --check --all`
- Targeted tests: `cargo test -p videorc-backend cohost`
- `cargo clippy -p videorc-backend -- -D warnings`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm --filter @videorc/desktop test`
- `pnpm test:scripts`
- `pnpm smoke:live-chat-fake-providers`
- `pnpm smoke:youtube-quota`, because automatic YouTube sends share the
  breaker and the budget.

## Out of scope

- A separate bot account, so viewers see "Buddy" instead of the streamer's
  name (plan 164 D3 follow-up).
- Remembering regulars across streams (plan 183, parked).
- Voice output for Buddy.

## Open questions for the owner

1. D2: should returning chatters get a "welcome back" too, or only
   first-timers? Recommended: both.
2. D3: should AI write all greetings, or welcomes only? Recommended: all,
   with your line as the style example and the fallback.
3. D5: should Answers reply only from your notes, or in character to any
   unanswered question? Recommended: notes only. Also: Answers on by default
   for new installs?
4. The built-in welcome lines and the daily AI greet cap (500).
