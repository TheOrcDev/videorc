# Golem

The Golem is the companion you create for your streams (plan 119 as Orcle,
renamed and made yours in plan 164). You name it, give it a personality and
its looks. It stands on your stream as an avatar with a comic bubble, reads
your chat, hears you, and, when you turn the modes on, posts to your chats as
you. There is no voice: the Golem talks through its bubble.

The code, wire and storage name is `cohost`. Everything a user reads says
Golem, or the name you gave it, never co-host and no longer Orcle.

## The promise

**The Golem posts only in the modes you turn on. Everything is off by
default.** (D4). It removes a comment only when you tell it to. The old
sentence "It never posts on its own" is gone; the modes below are the whole
truth about what the Golem sends.

Everything the Golem posts goes out **as you**, on your own account, on the
platforms you stream to (D3). There is no bot account.

## Where things live

| Place                                     | Job                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Golem tab** (sidebar, under Studio, ⌘9) | Creates. Name, personality, avatar (Still or Alive), reactions, motion, bubble style, greeting templates, the Answers and Banter switches, Cloud AI consent, voice commands, reports. |
| **Stream Manager** (⇧⌘J, the Golem pane)  | Operates. The chat mode (Off, Suggest, Auto), the three behaviour switches, Suggest cards, the Say box, the Show on stream switch, questions, flags.                                  |
| **Live Scene** (Studio → Scene canvas)    | Places. Where the Golem sits on each orientation, and whether it is on the stream and in the recording. See [overlays.md](overlays.md).                                               |

Each control has one home. The Golem tab shows the status of the chat mode
and points at Stream Manager; it has no switch of its own any more.

## Creating your Golem (Golem tab → Golem)

- **Name** (1 to 24 characters). The creature's name is what it answers to in
  chat and in voice.
- **Personality** (up to 1,200 characters), free text. Three example chips
  fill it. The personality rides every cloud tick with the name.
- **Looks**: four state tiles, Idle, Talking, Laughing, Thinking. Each tile
  takes an upload (PNG or WebP with alpha, JPEG for idle only, 4 MB) or a
  generated image (Premium + Cloud AI). "Generate all" makes the idle image
  first, then the other three as edits of it, so the character stays the
  same. A failed state leaves its tile empty and never blocks saving.
- **Bubble**: speech, thought or shout, with a live sample.
- **Start over** deletes the persona folder and starts a fresh persona id.

Only idle is required (D16). A missing state falls back to the persona's
idle image. With no images at all, the bundled default pack shows: the
owner's stone golem (`assets/golem/default/idle.webp`, master art in
`assets/brand/golem/`). The default pack ships the idle image only; talk,
laugh and think fall back to it until matching art exists. The avatar
generation cap is the web's (24 a day); the image model is a web
environment variable, never hardcoded in the desktop.

## Still and Alive (plan 168)

The Avatar section of the Golem tab picks how the Golem looks:

- **Still** is the four state images above. It is free.
- **Alive** is a pet pack: one transparent sprite atlas with 25 drawn look
  directions (a 5 × 5 grid of head turns) plus reactions (laugh, surprised,
  wink, kiss, blink, sleep, worried, annoyed, proud, confused, excited, calm,
  and Videorc's talk-a, talk-b and wave). The format is
  [page-pet](https://github.com/gvastethecreator/page-pet-skill)'s manifest
  v1, unchanged; see [third-party/page-pet.md](third-party/page-pet.md).

The preview in the tab is the real pet: it follows your pointer across the
window, reacts when you click it, blinks, breathes and falls asleep. Packs:

- **Import pack…** (I) takes any complete-character page-pet pack folder
  (`manifest.json` plus its PNG or WebP sheets). Importing is free. Two-layer
  legacy packs and AVIF sheets are refused with the reason. Guards: 32 MB per
  file, 128 MB per pack, at most 64 frames, sheets up to 8192 px.
- **Create** makes your own Alive Golem from your reference picture (Premium,
  see below).
- **Remove** deletes the worn pack and switches back to Still. The bundled
  pack cannot be removed.

### Reactions and Motion

**Reactions** maps what happens on stream to a reaction of the pack, each
editable, each with a Try button:

| Trigger                                                 | Default reaction |
| ------------------------------------------------------- | ---------------- |
| Follow                                                  | wave, else proud |
| Sub, resub, membership                                  | excited          |
| Sub gift, community gift                                | excited          |
| Cheer, bits, kicks, Super Chat, Super Sticker, Power-up | surprised        |
| Raid                                                    | surprised        |
| Watch streak                                            | proud            |
| Redemption                                              | wink             |
| A destination fails                                     | none             |

A greeting template can name its own reaction, and it wins. A reaction the
pack lacks falls back down the list, then to a small motion-only hop.
Moderation flags never react on air.

**Motion** (0 to 1, default 0.45) scales every bounce, squash and tilt; 0
keeps the drawn poses and drops all movement. **Sleep after** (Never, 1, 3, 5
or 10 minutes, default 3) puts the Golem to sleep with no chat, activity or
lines; anything wakes it with a surprised start. **Breathing** (on by
default) is a slow squash between events so it never looks frozen.

### On stream

The pet is drawn by the backend into the program video at the output frame
rate, on every leg, with page-pet's motion (ported, without GSAP). It looks
at the viewer by default, glances at the highlight card when one shows,
looks up while an answer is on its way, cycles its talk frames while its
bubble is up, blinks every few seconds and plays the reaction you mapped for
each event. Each orientation computes its own gaze, so the pet looks toward
the card wherever the card sits on that leg. The "nothing bounces" rule for
scene and camera motion does not apply to the Golem: it is a character.

### Creating an Alive Golem (Premium)

**Create** opens the creator:

1. **Reference**: your idle image, an upload or a generated picture. A vision
   model writes identity notes (palette, materials, proportions, and which
   side each asymmetric feature is on); you can correct them.
2. **Pilot**: four poses (front, left, right, laugh) to check the character
   holds. Redo up to three times.
3. **Build**: eight sheets are generated in the cloud (five look-direction
   strips, two reaction sheets, one talk and wave strip), then cut, aligned
   on the feet and packed on this computer.
4. **Review**: the 25 look directions in their grid with an arrow for the
   intended direction, the reactions below, and the live pet beside them.
   Mark each row "Looks right" or redo it. Saving needs every row marked.
5. **Save**: name the pack; the Golem becomes Alive.

Allowance: 3 creations per calendar month, each with 9 sheets and 6 redos;
pilots are capped at 3 per creation and 6 a day. Abandoning at the pilot
costs no creation; failed generations never count. The sources stay on this
computer.

## Free and Premium

| Feature                                          | Needs                                  |
| ------------------------------------------------ | -------------------------------------- |
| Name, personality, uploaded images, bubble style | Nothing                                |
| The Golem on stream and in the recording         | Nothing                                |
| Greetings (your own templates, no AI)            | Nothing                                |
| The Say box in Stream Manager                    | Nothing                                |
| Answers                                          | Premium + Cloud AI consent             |
| Banter                                           | Premium + Cloud AI consent             |
| Generated avatar images                          | Premium + Cloud AI consent + daily cap |
| Alive: importing a pack, the pet on stream       | Nothing                                |
| Alive: creating your own pet                     | Premium + Cloud AI consent + 3 a month |
| Questions, flags, promises, voice commands       | Premium + Cloud AI consent (as before) |

(D6, owner decision 2026-10-08.)

## The Golem on stream

A Still avatar is an image per state; an Alive avatar is a pet pack (see
above). Either way the comic bubble sits above its head, inside a rect you
place on the Live Scene canvas. Still states are `idle`, `talk`, `laugh` and
`think`; the image swaps and a reaction gives it a small hop.

- A bubble stays for `max(2.5 s, 60 ms × characters)`, capped at 10 s, wraps
  to at most four lines at the rect's width, and is always the light variant
  (the stream is not themed).
- The Golem renders after captions and under the highlight card. The card is
  the most urgent thing on screen, so it wins an overlap (owner answer 7).
- The Golem item ships with **both output switches off** (opt-in). Turn on
  "Show on stream" in the Stream Manager's Golem pane or on the Scene canvas;
  "Show in recording" lives on the canvas. The avatar is visible whenever
  the item is on for that output, bubble or not (D19).
- The Say box in the Golem pane puts your own words in the bubble: ↵ talks,
  ⌘↵ laughs. In Auto mode a Say also goes to chat; in Off and Suggest it is
  bubble only.
- Every session start clears the bubble; the avatar rides into the new video
  if its switch is on.

## Chat: the three modes and the consent

The Stream Manager's Golem pane holds the one control: the **Chat** mode,
`Off | Suggest | Auto`, and three switches under it, Greetings, Answers and
Banter.

- **Off** (the default): the Golem never posts. Off also means the Golem does
  not join the stream (`enabled: false`).
- **Suggest**: every message becomes a card in the Golem pane; one click (or
  ↵ on the newest) sends it, ⌫ dismisses it, and a card leaves on its own
  after 45 s. This is the mode the consent dialog lands you in.
- **Auto**: messages go out by themselves, within the throttle below. Auto
  needs its own confirm after the consent, every time.

The first time the mode leaves Off, the consent dialog says: "The Golem
posts to your chats as you, on the platforms you stream to, only in the
modes you turn on. You can watch every message in Reports." Accepting lands
in Suggest. Choosing Auto adds a second click under the sentence "Automatic
messages are sent without asking you first." The window remembers the
consent (`videorc.golemAutoChatConsent`); Auto asks every time.

Suggest or Auto saves `{enabled: true, listen: true}` with the mode, so the
Golem reads your chat and hears you; the Stream Manager grants Cloud AI
consent in the same click where it is needed. Off saves `{enabled: false}`
and `mode: off`; your other settings stay as they are.

The Golem's chat producer starts with the stream's live chat and stops with
it. The Golem tab's status line says where it stands: Off; On, joins your
next stream; Live now; or Needs attention, with a plain reason (sign in,
Premium, Cloud AI off, or a pause or error from the Golem server).

## The three behaviours

- **Greetings** (free, no AI): your own templates for follows, subs, resubs,
  gifted subs, community gifts, memberships, cheers, KICKs, Super Chats,
  Super Stickers, raids, watch streaks, Power-ups and redemptions, written in
  Golem tab → Chat → Greetings. Each template has a state (talk, laugh,
  think), an optional platform, and fields in braces: `{name}`, `{handle}`,
  `{platform}`, `{months}`, `{streak}`, `{count}`, `{amount}`, `{reward}`
  (the channel's points name or the reward title), `{names}` and `{others}`
  (a burst). The editor shows a live preview against a sample event, a
  warning when the text is over a platform's cap, and a warning for a brace
  nothing fills (it is posted as written). An empty list offers a starter
  set ("Welcome, {name}!", "{name} joined the ranks ({months} months)",
  "{amount} from {name}, much obliged", "{name} brings {count} warriors.
  Welcome!", "{name}, {streak} streams strong").
- **Answers** (Premium + Cloud AI): when a viewer asks the Golem by name
  (`@<name>` or the name in the message), the drafted reply becomes a
  message, at most one per cooldown (default 20 s, 1 to 3,600). Questions
  that do not name the Golem stay suggestions in the pane. Only while the
  web speaks tick contract v4.
- **Banter** (Premium + Cloud AI, off by default): one short line when your
  microphone has been quiet for 20 s, never within a minute of a greeting or
  an answer, at most one per cooldown (default 4 min). Only on a v4 tick
  session.

Every utterance has a text and a state. If the overlay is on, it shows in
the bubble; in Suggest the bubble shows only after the card is approved
(D7).

## Posts as you: platforms and caps

A greeting goes only to the platform the event came from, never fanned out.
An answer goes to the platform of the message it answers. Banter and a Say
go to every writable destination (D8).

| Platform | Cap            | Note                                                                |
| -------- | -------------- | ------------------------------------------------------------------- |
| Twitch   | 200 characters | `user:write:chat`                                                   |
| YouTube  | 200 characters | 50 quota units per send; skipped while the plan 094 breaker is open |
| Kick     | 500 graphemes  | `chat:write`                                                        |
| X        | 140 characters | OAuth 1 broadcast chat                                              |

Text is clipped to the strictest platform it reaches with an ellipsis, and
the log says so. Nothing is sent to a destination whose stream leg has
failed (plan 161).

## The throttle (D9)

Per destination, for every automatic send:

| Rule            | Value                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate            | At most 6 automatic sends a minute, never two within 5 s                                                                                                                  |
| Kind cooldown   | follow 10 s; sub, resub, gifted sub, community gift, membership 5 s; cheer, KICKs, Super Chat, Super Sticker 5 s; raid 60 s; watch streak 15 s; Power-up, redemption 10 s |
| Collapse        | More than 3 same-kind events inside a cooldown become one message using `{names}` and `{others}` ("Ana, Bo, Cy and 4 others"); 2 or 3 go out one per cooldown             |
| Community gifts | One greeting to the gifter; the individual gift rows inside it are skipped                                                                                                |
| Dedupe          | One greeting per (destination, viewer, kind) a session                                                                                                                    |
| Fresh only      | An Activity row older than 10 minutes on arrival (a reconnect replay) is never greeted                                                                                    |
| YouTube         | Nothing while the quota breaker is open; automatic sends count against the same budget                                                                                    |
| Failed legs     | Nothing to a destination whose stream has failed                                                                                                                          |
| Answers         | One per `answers.cooldownSeconds` (default 20 s)                                                                                                                          |
| Banter          | One per `banter.cooldownSeconds` (default 240 s), never within 60 s of a greeting or answer                                                                               |

Suggest and Auto both go through the throttle; a Suggest card is the same
utterance with `status: proposed`. Held greetings wait in a bucket and a
one-shot pump releases them.

Every automatic send carries a Golem-owned `operationId`: its echo in chat
is still yours (the account is yours), but it never counts as "the streamer
replied" (D10). Each send is written to the stream report as it lands.

## Wake words

Say "Golem" first, or your Golem's own name: "Golem, highlight the comment
from coders X", "Grum, put this one up". The name's words (lowercased,
ASCII-folded, 3+ letters) all work, so "Grum the Goblin" answers to Grum and
to Goblin; "golem" always works. The old "Orcle" spellings stay as hidden
aliases for one release (remove after 0.9.140); "oracle" and "orca" are
gone. The commands are in [orcle-commands.md](orcle-commands.md).

## Reports

**When.** The Golem saves a report when its session ends: when the stream
stops, or when you turn the Golem off. Turning it off and on again during
the same stream folds both parts into one report. If the app crashes
mid-stream, that stream has no report. A stream where only greetings ran
still has a report (posts only, `segments: 0`).

**What.** Counts and what became of things, never raw chat or drafts:

- questions caught, answered on air, replied, marked answered, dismissed,
  restored and shown on stream;
- the questions themselves, up to 200: wording, up to five askers, platforms,
  priority and outcome;
- flags raised and dismissed, by kind and severity;
- promises heard, kept, dismissed and reminded, plus up to 20 still open when
  the stream ended;
- first-timers seen and greeted, by voice, in chat or by hand;
- the alerts viewers raised, with the most viewers who said it at once;
- recaps offered, drafted and dismissed;
- **posts** (plan 164): every message the Golem sent as you, up to 200, with
  the trigger (greeting, answer, banter, say), the text, the platforms and
  the result (sent, partial, failed). Reports → "Posted as you".

**Where.** In the local Videorc database (table `cohost_reports`, one row per
session). It is deleted with the recording, and it is never sent to Videorc.
It holds viewer names and question text, so it must never be added to the
support bundle or to any upload.

**Reading it.** The Golem tab's Reports sub-tab shows the newest stream, with
a switcher for recent ones. In Library, a stream's row menu has "Golem
report", which opens the tab on that session. A stream the Golem was off for
still shows its moments and chat totals.

## Clip that

Say "clip that" while the Golem hears you (or live captions are on), or
press Mark clip: in the Stream Manager, from a Stream Deck or the phone
remote, or with the Mark clip shortcut from Settings → Shortcuts. The toast
reads "Clip marked at 12:34. It's in your stream report in Golem."

Marks are saved only while Videorc records to a file. With Record off, the
toast says the clip can't be saved.

The report shows them as **moments**: every mark, plus up to three chat peaks,
each snapped to the transcript with an excerpt. Moments are worked out when
the report is read and never stored. There is no clip file export.

Session markers ("Golem, make a marker here for [title]", or the free local
`/marker [title]`) are covered in [session-markers.md](session-markers.md).

## Where the Golem works live

Live, the Golem works in the Stream Manager, in the Comments window (⇧⌘J).
The Golem pane sits above the chat and is keyboard-first: ⌘J focuses it, ↑
and ↓ move, R replies, H shows the comment on stream, A marks it answered
and ⌫ dismisses. The pane's header shows the state image, the name, the
bubble while one is up, the Show on stream switch, the Say box and the chat
mode. While you're live, the Golem tab shows "Open Stream Manager".

## Consent: Cloud AI

Cloud AI has one home: the Cloud AI row in the Golem tab. It is the only
place to revoke it. The consent dialogs (Golem Live, Clean cut, the chat
mode in Stream Manager) can grant it too, and all write the same stored
choice (`videorc.aiConsent`). There is no second consent store. A change
applies to a stream that is already live.

What Cloud AI covers (`CLOUD_AI_USES`, one list everywhere):

- Golem reads your live chat.
- Golem hears you while you're live: your microphone audio goes to Videorc's
  cloud speech-to-text and comes back as text (even with live captions off).
- Golem's avatar images: your description, and its idle picture for the
  other states, go to Videorc's cloud AI; the pictures are kept on this
  computer.
- Golem replies in chat as you: with Answers or Banter on, its replies are
  drafted by Videorc's cloud AI and posted on your own account, only in the
  modes you turn on.
- Creating an Alive Golem: your reference picture and its description go
  to Videorc's cloud AI; the pictures are kept on this computer.
- Clean cut uploads a recording's audio, never the video, in short chunks
  for a word-by-word transcript, and sends its sentences to Videorc's cloud
  AI to find retakes. Neither is kept on Videorc servers after the job
  finishes.

What is kept, and where:

- Videorc servers don't keep your chat or your audio.
- When you record, the transcript is saved next to the recording
  (`<recording>.srt`) on this computer.
- A short report of each stream is saved on this computer.

Posting consent (the chat mode) is separate: it lives in the Stream Manager
window's storage (`videorc.golemAutoChatConsent`) and covers sending, not
cloud use.

## For developers

Settings and live state:

- `cohost.settings.get` and `cohost.settings.set`; Stream Manager sends
  `{enabled: true, listen: true, autoChat: {...}}` or `{enabled: false,
autoChat: {mode: 'off'}}`.
- The `cohost.state` event carries the live pane, plus `utterances[]`
  (oldest first, at most 20, omitted while empty) and `autoChatSends`
  (omitted while zero).

The persona and its images (Phase A):

- `cohostSettings.persona` holds `id` (`"default"` until Start over writes a
  uuid), `name`, `personality`, `bubbleStyle`, `images` (four optional
  relative paths `<personaId>/<state>.<ext>`, absent never null) and
  `source` (`default | uploaded | generated`). `autoChat` holds `mode`,
  `greetings {enabled, templates[]}`, `answers {enabled, cooldownSeconds}`
  and `banter {enabled, cooldownSeconds}`, all off by default. Both ride
  `cohost.settings.get/set` as whole objects; the backend refuses an
  out-of-bounds persona with `cohost-persona-invalid` and bad templates with
  `cohost-auto-chat-invalid` (`cohost.rs::validate_persona` /
  `validate_auto_chat`).
- Uploads go through main (`golem-assets:import-image(personaId, state)`):
  sniffed PNG/WebP (JPEG for idle), 4 MB, copied to
  `userData/golem-assets/<personaId>/`, served as
  `videorc-asset://golem/<personaId>/<state>.<ext>`. `golem-assets:remove`
  deletes the folder for Start over. `golem-assets:read-image` hands the
  bytes to the overlay rasterizer.
- Generation is `cohost.avatar.generate {state, prompt, style}`: accepted at
  once with `{requestId, state}`, the outcome arrives as
  `cohost.avatar.generated {requestId, state, path?, opaque, error?}`. The
  backend posts to the web's `/api/ai/cohost/avatar` and writes the PNG into
  the managed folder main hands over as `VIDEORC_MANAGED_GOLEM_ROOTS`; the
  renderer then patches `persona.images[state]` (one writer of the persona).
  One generation at a time per process (`cohost-avatar-busy`). Generate is
  on only when `/api/ai/capabilities` reports `cohost.avatar.enabled`, with
  `remainingToday` and `dailyLimit` from the web.
- The bundled default pack is `lib/golem-default-pack.ts` (lazy chunks only,
  never the eager shell): the owner's stone golem (master in
  `assets/brand/golem/`) as the idle image, with the other states falling
  back to it; `persona.source: 'default'` means "use it".
- Wake words: `cohost_command::wake_words(name)` = `["golem", <name tokens>,
"orcle", "orkle", "orcel", "orkel", "orcl", "orcal"]`; the persona tokens
  live in a process-wide slot set on every settings change.

The Golem on stream (Phase C):

- The state machine is `crates/videorc-backend/src/golem_overlay.rs`:
  `GolemOverlayState {persona_id, state, bubble, generation}`, pure and
  clock-injected; one tokio sleep per bubble keyed on its generation.
  `golem_overlay::show_bubble(app, text, state)` is the one way a bubble
  appears, and `show_for_utterance(app, &utterance)` is the gate in front of
  it (D7/D18): a `sent` utterance bubbles as it lands, a `bubble-only` one
  and the Say box bubble at once, an answer on its way to chat may show
  `think`, and nothing shows while the Golem's `showOnStream` and
  `showInRecording` are both off. `settle(app)` ends a `think` that never
  became a bubble; `clear(app)` runs at every session start.
- RPCs: `cohost.golem.status` (observation),
  `golem.overlay.set {target: 'primary' | 'auxiliary', pngBase64, rect}`
  (mutation, the captions slot shape; decoded off the async runtime) and
  `golem.overlay.clear {target?}` (mutation, plan 168). Event
  `cohost.golem.state {personaId, state, bubble: {text, until} | null}`.
- The pet is drawn by the backend (plan 168 Phase B,
  `crates/videorc-backend/src/golem_sprite.rs`): the persona's pack (Alive)
  or its state images as a flat pack (Still) is pre-scaled per output leg
  into a BGRA atlas and drawn as one quad per leg by the CPU, Metal and
  D3D11 paths. The renderer pushes the bubble only.
- Renderer: `lib/golem-overlay.ts` (lazy) lays out and paints the bubble per
  target canvas (`renderGolemBubblePng`, its tail tip on the bitmap's
  bottom-centre, which the compositor puts on the pet's head) and the
  settings sample's avatar-plus-bubble composite; `lib/golem-overlay-targets.ts`
  (eager, asset free) plans the targets and keys the push. The Studio pushes
  on every change of bubble, style, placement or canvas, session or not (the
  slot is app-global), and clears the slot when the bubble ends. Six
  paint-log snapshots in `lib/__snapshots__/golem-overlay.test.ts.snap`.
- Stream Manager relay: `CohostWindowState.golem?` (persona, state, bubble,
  `showOnStream`); `cohost-action` kinds `golem-say {text, state}` and
  `golem-show-on-stream {showOnStream}`; `golem-say` carries the live
  `sessionId` when the window shows one, and the Studio routes it to
  `cohost.utterance.say` (so a manual line is one utterance that bubbles at
  once and posts per the chat mode) and the switch to `overlays.layout.set`.
- Placement, the leg plan and the render paths are in
  [overlays.md](overlays.md).

Automatic chat (Phase D):

- Backend: `cohost_greetings.rs` (facts, templates, collapse),
  `cohost_throttle.rs` (pure, clock-injected), `cohost_auto_chat.rs` (the
  lane: mode, proposals, answers, banter, the Say box), and the send path in
  `cohost.rs` (`send_automatic`, the pump that releases held greetings). The
  lane is engine-wide and follows the live-chat session, not the Premium
  tick session, because greetings are free. `off` produces nothing from any
  method.
- Every send is `live_chat::send_live_chat_message` with a Golem-owned
  `operationId` registered on the lane; `live_chat.rs` skips
  `note_own_send_delivered` for it (no question closes, nobody is marked
  greeted) but still notes the echo.
- Utterance on the wire: `{id, text, state, trigger: {kind: 'greeting' |
'answer' | 'banter' | 'manual', eventId?, messageId?}, destinationIds,
status: 'proposed' | 'sent' | 'dismissed' | 'bubble-only' | 'failed', at,
expiresAt?}`. Empty `destinationIds` means every writable destination.
- RPCs: `cohost.utterance.approve` / `cohost.utterance.dismiss`
  `{sessionId, utteranceId}` and `cohost.utterance.say {sessionId?, text,
state?}` (mutations). Without a `sessionId` (no live chat) a Say line is
  recorded `bubble-only`; a named session must be the live one
  (`cohost-session-mismatch`).
- Tick v4: the desktop sends `promptVersion: 4` with `persona {name,
personality}` only when `/api/ai/capabilities` reports `cohost.tick: 4`
  (`cohost::set_tick_capability`); otherwise v3 goes out exactly as before.
  The ladder is `[4, 3, 2, 1]`; `prompt-version-unsupported` steps 4 → 3 and
  the persona leaves. v4 replies carry `addressed` and `mood` per question;
  `intent: banter` returns `banter {text, mood}`. Mood → state: amused →
  laugh, thinking → think, neutral → talk.
- Stream Manager relay: `cohost-enable` carries an `autoChat` block (mode
  and the three switches); `cohost-action` kinds `approve-utterance`,
  `dismiss-utterance`, `say-utterance` (with `text` and `state?`) follow the
  session kinds (they send to chat).
- Reports: `CohostSessionReport.posts[]` (`{id, at, trigger, text,
destinations, result}`, cap 200, omitted while empty) written as each send
  lands through `Database::append_cohost_report_post`; `merged_with` unions
  by id.

The report:

- `cohost.report.get {sessionId}` returns
  `{sessionId, report, moments, chat: {messages, byPlatform}}`. `report` is
  `null` when the Golem left none for that session.
- `cohost.report.latest` takes no params and returns the same payload for the
  newest session that has a report, else the newest streamed session, or
  `null` when there is neither.
- The `cohost.report.saved {sessionId}` event fires when a report is written
  or folded into the one already there.

The report format is `CohostSessionReport` with `version: 1`
(`crates/videorc-backend/src/protocol.rs`), mirrored in
`apps/desktop/src/shared/backend.ts` with closed validators in
`apps/desktop/src/shared/backend-rpc-contract.ts` and a fixture in
`protocol-fixtures/high-risk-contracts.json`. A stored report with another
version reads as no report, never as an error. Optional fields are omitted,
never null.

Code:

- Backend: `cohost.rs` owns the engine, the lane and the report (built in
  `stop_session`, saved after the engine lock is released); `cohost_avatar.rs`
  the generation; `moments.rs` ranks moments; `transcript.rs` parses the
  `.srt`; `storage.rs` owns `cohost_reports`.
- Renderer: `components/tabs/orcle-tab.tsx` with `lib/orcle-tab-view.ts` and
  `lib/orcle-tabs.ts` (sub-tabs Golem, Chat, Voice, Reports, Clean cut);
  `components/golem-persona-section.tsx`, `golem-greetings-section.tsx`,
  `golem-bubble-sample.tsx`; `lib/golem-auto-chat-view.ts` (the pure side of
  the editor and the mode control); `components/cohost-pane.tsx` and
  `components/stream-manager/golem-chat-controls.tsx` in Stream Manager;
  `components/orcle-report-card.tsx` with `lib/orcle-report-view.ts` and
  `hooks/use-orcle-report.ts`, all under `apps/desktop/src/renderer/src/`.

Checks:

- `pnpm smoke:cohost-fake` runs the Golem against a fake server and asserts
  the saved report's counts (it has no capabilities route, so the desktop
  sends v3 there).
- `pnpm smoke:live-chat-fake-providers` ends with the Golem scenario: three
  templates in `auto` land exactly four greetings on the fake destinations
  (one per event, 5 s apart on Twitch), the report holds the four posts, and
  the same rows with the mode `off` send nothing.
- `pnpm smoke:orcle-commands` covers the wake words.
- `cargo test -p videorc-backend cohost` covers the settings round trip, the
  greeting engine, the throttle (a 50-follow burst: one now, one collapsed at
  +10 s, the rest deduped), the lane and the bubble state machine.
- `node scripts/capture-ui-pages.mjs` captures every page and opens the
  Golem tab by its id `ai`; `--theme=light` or `--theme=dark` switches the
  app first and adds the theme to every file name.
