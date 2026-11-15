# Avatar

Your avatar is the character on your stream (plan 239). You name it, give it
a personality and a look, and it stands on your stream with a comic bubble:
it greets people, reacts to follows, subs and raids, and says what you type
in the Say box. There is no voice: it talks through its bubble. Viewers see
it; you set it up.

It lives on the **Avatar** page, in the sidebar's Setup group between
Captions and Output (⌘6), and in the Avatar block at the foot of the Stream
Manager's Sidekick pane. Sidekick, the helper only you see, has its own page
and its own doc, [buddy.md](buddy.md). One rule joins them: **Sidekick
writes, the avatar says.** With Sidekick Live on, Sidekick's lines (Answers,
Banter and greetings written with AI) come out in your avatar's bubble, in
its voice. With Sidekick off, your avatar still greets with the built-in
lines or yours, reacts and takes the Say box: that is the free product.

In copy, "avatar" is a lower-case common noun ("your avatar", "My avatars"),
"Avatar" names the page and the block, and the character goes by its own
name wherever one is at hand ("Flint on stream", "Flint talks"). Names a
program reads keep `buddy` and `cohost` (`cohost.buddy*`, `buddy.overlay.*`,
`/api/buddy/*`, `videorc://buddy`, the persona's saved shape, file names;
plan 236 D1). The default avatar is **Flint the Golem**, the owner's stone
character and one of the official avatars.

The Preview shows the program: your avatar appears whenever a running output
carries it, or either switch is on while nothing runs. An avatar with both
switches off is never drawn, even while selected. That holds in every row:
with Clips on and "Show on stream" only, the Preview shows the avatar while a
saved clip does not, and during a split record + stream the Preview shows a
stream-only avatar the recording leaves out (the program leg,
[overlays.md](overlays.md)). On Windows and Linux, where the Preview is the
proof surface, your avatar is drawn there by the same rule, alive and with
its bubble.

## Where things live

| Place                                                           | Job                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Avatar page** (Setup, between Captions and Output, ⌘6)        | Creates and sets up. **Profile**: the status row (the picture, the name, where it shows, "Place on Scene" ⌘3), My avatars, Name and personality with About you, the bubble and Start over, the Look section (Still or Alive, Test, Import moves…, Create), Reactions and Motion. **Greetings**: the lines it says when someone arrives or chat does something. |
| **Stream Manager** (⇧⌘J, the Avatar block of the Sidekick pane) | Operates live. The living preview, the name and the bubble while one is up; "{name} talks" (Off, Bubble, Suggest) with its chips; the Say box, the reactions and the "{name} on stream" switch.                                                                                                                                                                |
| **Scene page** (⌘3, the Live Scene canvas)                      | Places. Where your avatar sits on each orientation, and whether it is on the stream and in the recording. The item is called Avatar there. See [overlays.md](overlays.md).                                                                                                                                                                                     |

Each control has one home. The status row on Avatar → Profile says where
viewers see your avatar ("On stream and in recordings", "On stream, not in
recordings", "In recordings, not on stream" or "Not on stream or in
recordings") and holds no third copy of the switches: the Scene canvas and
the Stream Manager are their homes. While your avatar is not on stream, one
line under the row says how: "{name} isn't on stream yet. In Stream Manager,
turn on "{name} on stream" to show it."

The page reopens on the tab used last (`videorc.avatarTab`), and ⌘K lists
both tabs under "Avatar". The onboarding, the Alive creator and the Test
dialog open from Avatar → Profile.

## Creating your avatar (Avatar → Profile)

- **Name** (1 to 24 characters). A fresh install and Start over wear the
  name Flint. With Sidekick, your avatar answers viewers who ask it by name.
- **Personality** (up to 1,200 characters), free text. Three example chips
  fill it. The personality rides every Sidekick tick with the name, so
  Sidekick's lines sound like your avatar.
- **About you** (up to 4,000 characters): what your avatar knows about you.
  Sidekick answers viewers' questions from it, and its reply drafts read it.
  It stays here, with the name and personality (plan 239 D4); Sidekick →
  Chat → Replies points to it.
- **Bubble**: speech, thought or shout, with a live sample.
- **A new look** (plan 170): **New avatar…** in My avatars (below) opens the
  four-step onboarding, the same steps as on videorc.com/avatar/create:
  _Meet your avatar_ (a stream demo, the official five, what it does),
  _Describe it_ (words, a picture for inspiration such as a pet, a logo or a
  sketch, or both), _Give it a personality_ (name, personality, About you)
  and _Create your avatar_ (⌘↵, Premium + Cloud AI, 4 of the day's images).
  The web draws the idle character in the house look and talk, laugh and
  think as edits of it (plan 169), and saves the set to your Videorc
  account. The set is a draft until **Use as my avatar**; **Discard**
  deletes it from the account, and **Redo** (R on a focused tile) remakes
  talk, laugh or think from the draft's idle (1 image). Every string comes
  from `docs/buddy-onboarding-copy.md`. The Look section's Still panel keeps
  the current look and **Make it Alive**, which opens the Alive creator with
  that look as its reference.
- **Start over** ("Start over with a new avatar?") deletes the persona
  folder and starts a fresh persona with a new id and the name Flint. Your
  greetings and chat settings stay.

Only idle is required (D16). A missing state falls back to the persona's
idle image. With no images at all, the bundled default pack shows: Flint,
the owner's stone character (`assets/buddy/default/`, masters in
`assets/brand/buddy/`), with its own idle, talking, laughing and thinking
pictures; the last three were generated from the idle art. A persona with
its own idle never borrows them: its missing states show its own idle. The
look generation cap is the web's (24 a day); the image model is a web
environment variable, never hardcoded in the desktop.

### The name Flint (plan 239 D2)

Until plan 239 the official stone character was named Sidekick, the same
word as the helper. It is Flint now: in the official catalog
(`protocol-fixtures/buddy-official-catalog.json`), the default persona name
(`COHOST_DEFAULT_PERSONA_NAME` in `cohost.rs`, `DEFAULT_AVATAR_NAME` in
`shared/avatar-name.ts`), the name placeholder and every fallback.

A saved avatar named exactly "Sidekick" becomes "Flint" once, at the first
launch after the update (settings migration version 2,
`migrate_cohost_settings`), but only while it still wears the default look:
the bundled pictures (Still or the bundled moves) or the official character
from the library. "Sidekick" on your own pictures, an imported pack or
another library avatar is your choice and stays. A later load changes
nothing, even after you name it "Sidekick" again. Library rows on
videorc.com are yours and never change.

## My avatars: the library (plan 170)

My avatars sits on Avatar → Profile, under the status row, and in your
account on videorc.com (`/account/avatars`); both show the same library.

- **Official** (free, signed in or not, works offline): Flint the Golem
  (the owner's stone character), Golmar the Orc, Nib the Goblin, Captain
  Barnacle the Pirate and Bolt the Robot. Their names, taglines and personalities are
  `protocol-fixtures/buddy-official-catalog.json`; their four poses ship
  with the app (`assets/buddy/default/` and `assets/buddy/official/`,
  masters and the generator in `assets/brand/buddy/`) and the backend
  bundles the same files for the stream. **Use** sets the pictures, name and
  personality and leaves your About you alone.
- **Made by you** (signed in): every avatar you create, here or on the web,
  up to 30. **Use**, **Rename**, **Edit personality** (with About you),
  **Delete** and **Make it Alive**. Using one downloads its four poses and
  sets the name, personality and, when it has one, About you. Your edits to
  a linked avatar's name, personality or About you go back to the account
  about 2 s after you stop typing.
- **Sync** (D12): the app reads the account's choice at launch, when My
  avatars opens, on window focus (at most once a minute) and from the
  `videorc://buddy` link. A choice made on the web applies when your avatar
  is linked to the library or is still the untouched default; an avatar
  made only on this computer (an imported pack, a look kept while signed
  out) is never overwritten, and My avatars offers the web's choice with
  **Use** instead. Nothing changes while a recording or stream is live: the
  choice waits for the session to end. Signed out, nothing syncs and the
  official five still work.
- **videorc://buddy** (D18), from "Open in Videorc" on the web, focuses the
  app, opens Avatar → Profile and syncs; `?alive=<id>` then uses that avatar
  and opens the Alive creator there. The link keeps its `buddy` name.
- The first launch with the untouched default avatar shows one line in My
  avatars: "Make this avatar your own, or pick another." with **Start**.

## Still and Alive (plan 168)

The Look section of Avatar → Profile picks how your avatar looks:

- **Still** is the four state images above. It is free.
- **Alive** is a pet pack: one transparent sprite atlas with 25 drawn look
  directions (a 5 × 5 grid of head turns) plus reactions (laugh, surprised,
  wink, kiss, blink, sleep, worried, annoyed, proud, confused, excited,
  calm, and Videorc's talk-a, talk-b and wave). The format is
  [page-pet](https://github.com/gvastethecreator/page-pet-skill)'s manifest
  v1, unchanged; see [third-party/page-pet.md](third-party/page-pet.md).

The preview in the Look section is the real pet: it follows your pointer
across the window, reacts when you click it, blinks, breathes and falls
asleep. Packs:

- **Import moves…** (I) takes any complete-character page-pet pack folder
  (`manifest.json` plus its PNG or WebP sheets). Importing is free. Two-layer
  legacy packs and AVIF sheets are refused with the reason. Guards: 32 MB
  per file, 128 MB per pack, at most 64 frames, sheets up to 8192 px.
- **Create** makes your own Alive avatar from your reference picture
  (Premium, see below).
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
keeps the drawn poses and drops all movement. **Sleep after** (Never, 1, 3,
5 or 10 minutes, default 3) puts your avatar to sleep with no chat, activity
or lines; anything wakes it with a surprised start. **Breathing** (on by
default) is a slow squash between events so it never looks frozen.

### On stream

The pet is drawn by the backend into the program video at the output frame
rate, on every leg, with page-pet's motion (ported, without GSAP). It looks
at the viewer by default, glances at the highlight card when one shows,
looks up while an answer is on its way, cycles its talk frames while its
bubble is up, blinks every few seconds and plays the reaction you mapped for
each event. Each orientation computes its own gaze, so the pet looks toward
the card wherever the card sits on that leg. The "nothing bounces" rule for
scene and camera motion does not apply to your avatar: it is a character.

### Test your avatar (plan 169)

**Test** under the preview (T while the Look section has focus) opens your
avatar big on a neutral stage, Still or Alive, to see each state as viewers
do:

- **States** (1 to 4): Idle lives (blinks, breathes, sleeps); Talking runs
  the stream's talk cycle (the pack's talk frames, else the Still talk
  picture with a bob); Laughing laughs into the laugh picture and holds it;
  Thinking holds the think picture, or an Alive pack looks up-left. A pack
  without a drawing falls back like the stream does, and a line says so.
- **Reactions**: every reaction of the pack, plus Hop, played over the held
  state.
- **Show the bubble** (on by default): the stream's own bubble with a sample
  line, at its stream proportions, over the head while Talking.

It is a sandbox in the window: nothing goes to the stream, chat, the backend
or the settings.

### Creating an Alive avatar (Premium)

**Create** opens the creator:

1. **Reference**: your idle image or an upload. A vision model writes
   identity notes (palette, materials, proportions, and which side each
   asymmetric feature is on); you can correct them.
2. **Pilot**: four poses (front, left, right, laugh) to check the character
   holds. Redo up to three times.
3. **Build**: eight sheets are generated in the cloud (five look-direction
   strips, two reaction sheets, one talk and wave strip), then cut, aligned
   on the feet and packed on this computer.
4. **Review**: the 25 look directions in their grid with an arrow for the
   intended direction, the reactions below, and the live pet beside them.
   Mark each row "Looks right" or redo it. Saving needs every row marked.
5. **Save**: name the pack; your avatar becomes Alive.

Allowance: 3 creations per calendar month, each with 9 sheets and 6 redos;
pilots are capped at 3 per creation and 6 a day. Abandoning at the pilot
costs no creation; failed generations never count. The sources stay on this
computer.

## Your avatar on stream

A Still avatar is an image per state; an Alive avatar is a pet pack (see
above). Either way the comic bubble sits above its head, inside a rect you
place on the Live Scene canvas. Still states are `idle`, `talk`, `laugh`
and `think`; the image swaps and a reaction gives it a small hop.

- A bubble stays for `max(2.5 s, 60 ms × characters)`, capped at 10 s, wraps
  to at most four lines at the rect's width, and is always the light variant
  (the stream is not themed).
- Your avatar renders after captions and under the highlight card. The card
  is the most urgent thing on screen, so it wins an overlap (owner answer
  7).
- The Avatar item ships with **both output switches off** (opt-in). Turn on
  "{name} on stream" in the Avatar block of the Stream Manager's Sidekick
  pane, or "Show on stream" on the Scene page's canvas; "Show in recording"
  lives on the canvas. "Sidekick, show up" and "Sidekick, go away" flip the
  same switch by voice ([buddy-commands.md](buddy-commands.md)). Your avatar
  is visible whenever the item is on for that output, bubble or not (D19).
- The Say box in the Avatar block puts your own words in the bubble: ↵
  talks, ⌘↵ laughs. It is bubble only in every mode; a Say never goes to
  chat. It shows at once and replaces whatever is up; greetings and
  Sidekick's lines wait for it. The reaction chips beside it play a reaction
  on air, each disabled when the pack has no such reaction.
- Bubble lines are paced for reading, not for chat limits (plan 211 D7): a
  line waits for the current bubble to end plus 0.5 s; at most 3 lines wait,
  and a line that has waited 20 s is dropped (counted `stale`). Your own Say
  line shows at once. Text over 200 characters is clipped at a word with
  "…". An answer in the bubble starts with "@{name}", so it is clear who it
  answers (D8).
- Every session start clears the bubble; your avatar rides into the new
  video if its switch is on.

**"{name} talks"** sits in the Avatar block, named after your avatar ("Flint
talks"): **Off** says nothing on its own, **Bubble** (the default) says
greetings and Sidekick's lines in its bubble on stream and nothing in chat,
and **Suggest** makes each line a card you post in chat with one click, said
in the bubble when it lands. Bubble speaks only while your avatar is on an
output. The behaviour chips beside it open each behaviour's home: Greetings
opens Avatar → Greetings, Answers and Banter open Sidekick → Chat. How the
control, the posting consent and the off-the-picture notice work is in
[buddy.md](buddy.md#how-sidekick-talks-through-your-avatar).

## Greetings (Avatar → Greetings)

Greetings are free and on by default (plan 192). They run with Sidekick
Live off: no Premium, no consent and no switch is needed. Your avatar says:

- **welcomes** for a chatter's first message ever in the channel ("Hi
  {name}, welcome to the stream!") and a returning chatter's first message
  this stream ("Welcome back, {name}!");
- lines for follows, subs, resubs, gifted subs, community gifts,
  memberships, cheers, KICKs, Super Chats, Super Stickers, raids, watch
  streaks, Power-ups and redemptions.

Every kind has a built-in line
(`protocol-fixtures/buddy-builtin-greetings.json`), so Greetings works with
no setup; an empty list never means silence. On Avatar → Greetings a kind
without your own line shows its built-in line marked Default: editing it
saves your line, switching it off saves a switched-off line (a kind whose
lines are all off says nothing). Each line has a state (talk, laugh,
think), an optional platform, and fields in braces: `{name}`, `{handle}`,
`{platform}`, `{months}`, `{streak}`, `{count}`, `{amount}`, `{reward}` (the
channel's points name or the reward title), `{names}` and `{others}` (a
burst; in a burst `{name}` is the names list too). Welcomes skip the
streamer's own account, known bots (Nightbot, StreamElements, ...), names
with a link and old rows. The editor shows a live preview against a sample
event, a warning when the text is over a platform's cap, and a warning for a
brace nothing fills.

**Write greetings with AI** is Sidekick's (Premium + Cloud AI): its switch
lives in Sidekick → Chat → Replies, beside Answers and Banter, because it
needs Sidekick Live. Avatar → Greetings shows one line that says whether it
is on ("On: Sidekick writes each greeting in {name}'s voice, with your line
as the example." or "Off: {name} says your lines as they are.") and a way
there, "Sidekick → Chat". Your line stays the example and the fallback.

**How often.** In Bubble the bubble is one destination shared by every
platform, so the throttle's rate, kind cooldowns, collapse ("Ana, Bo, Cy and
4 others"), dedupe and freshness hold across all your chats, and a viewer is
greeted once per platform a session (plan 211 D7). Held greetings wait in a
bucket and a one-shot pump releases them. The whole table is in
[buddy.md](buddy.md#the-throttle-d9). In Bubble a greeting shows only while
your avatar is on an output; off the picture it is skipped and counted
`no-bubble` in the report. In Suggest a greeting is a card that goes only to
the platform the event came from.

**Regulars** (plan 225). A regular's arrival makes your avatar wave; in
Bubble the bubble says the regular, comeback or milestone welcome (the
welcome kinds on Avatar → Greetings). One wave per 20 seconds of regulars;
every milestone gets its own moment. "Welcome regulars on stream" off makes
every arrival the plain returning welcome. **Wave** in the Stream Manager's
"Welcome back" list plays the regular reaction and, in Bubble, says "Hey
{name}!". Nothing goes to chat. Community itself is Sidekick's
([buddy.md](buddy.md#community-know-your-viewers-across-platforms-plan-225)).

## Free and Premium

| Feature                                                     | Needs                                  |
| ----------------------------------------------------------- | -------------------------------------- |
| Name, personality, About you, uploaded images, bubble style | Nothing                                |
| The official avatars                                        | Nothing                                |
| Your avatar library across the web and computers            | A Videorc account                      |
| Your avatar on stream and in the recording                  | Nothing                                |
| Greetings and welcomes (built-in or your lines)             | Nothing                                |
| The Say box and reactions in Stream Manager                 | Nothing                                |
| Alive: importing a pack, the pet on stream                  | Nothing                                |
| A look made with AI (generated avatar images)               | Premium + Cloud AI consent + daily cap |
| Alive: creating your own                                    | Premium + Cloud AI consent + 3 a month |

Pricing did not change in plan 239 (owner decision 4; D6, owner decision
2026-10-08). Sidekick's features are in [buddy.md](buddy.md#free-and-premium).

## For developers

The persona and its images (Phase A):

- `cohostSettings.persona` holds `id` (`"default"` until Start over writes a
  uuid), `name`, `personality`, `bubbleStyle`, `images` (four optional
  relative paths `<personaId>/<state>.<ext>`, absent never null), `source`
  (`default | uploaded | generated`), the look (`avatar`: Still, or Alive
  with a `packId`), `motion`, `reactions` and `libraryAvatarId` when it is
  linked to the library.
  About you is `cohostSettings.notes`. Both ride `cohost.settings.get/set`
  as whole objects; the backend refuses an out-of-bounds persona with
  `cohost-persona-invalid` (`cohost.rs::validate_persona`, "The avatar needs
  a name.").
- Persona pictures live in `userData/buddy-assets/<personaId>/` (the
  managed folder main hands the backend as `VIDEORC_MANAGED_BUDDY_ROOTS`),
  served as `videorc-asset://buddy/<path>`: `<state>.<ext>` (uploads from
  before plan 169) or `<state>-<tag>.png` (a kept look; the tag is the
  draft's first 8 hex digits, so each kept look has its own paths and no
  surface shows a cached picture). `buddy-assets:remove` deletes the folder
  for Start over; `buddy-assets:read-image` hands persona picture bytes to
  the overlay rasterizer.
- The look (plan 169, `cohost_avatar.rs`): `cohost.avatar.create
{description?, inspirationBase64?}` (the picture at most 3 MB decoded,
  under Vercel's request cap; the renderer fits it within 1024 px) and
  `cohost.avatar.redo {requestId, state}` answer `{requestId}` at once; the
  backend posts to the web's `/api/ai/cohost/avatar/set` (190 s, 40 MB
  response cap) on its own task and reports `cohost.avatar.progress
{requestId, state, phase: working | done | failed, path?, error?}` and
  `cohost.avatar.draft {requestId, images, failed}`. The set lands in
  `<personaId>/drafts/<requestId>/<state>.png` (one draft per persona,
  replaced only by a create that succeeded); `cohost.avatar.keep
{requestId}` moves it into the persona folder, saves `images` and `source:
generated` and returns the settings; `cohost.avatar.discard {requestId}`
  deletes it; `cohost.avatar.draft.get` offers a draft left on disk (and the
  job running) after a restart. One job at a time per process
  (`cohost-avatar-busy`). Create is on only when `/api/ai/capabilities`
  reports `cohost.avatar.enabled` with at least 4 `remainingToday` (Redo
  needs 1).
- The bundled default pack is `lib/buddy-default-pack.ts` (lazy chunks
  only, never the eager shell): Flint in all four states (masters in
  `assets/brand/buddy/`). The backend's Still pack embeds the same four
  files (`buddy_pet.rs`, `include_bytes!`); a persona with its own idle
  falls back to that idle for missing states, never to ours.
  `persona.source: 'default'` means "use it".
- The name migration (plan 239 D2) is `migrate_cohost_settings` in
  `cohost.rs`: version 1 (plan 236) renames an exact "Buddy" to "Sidekick",
  version 2 renames an exact "Sidekick" that still wears the default look
  (linked to the official character, or `source: default` on Still or the
  bundled moves) to "Flint". The version row (`cohostSettingsMigration`) is
  written only once the renamed settings are saved.

The library (plan 170):

- `cohost.library.get` returns the cached `BuddyLibraryState`
  (`apps/desktop/src/shared/buddy-library.ts`); `cohost.library.sync
{reason}`, `.use {avatarId}`, `.update {avatarId, name?, personality?,
context?}` and `.delete {avatarId}` accept at once and report through the
  `cohost.library.changed` event (one job at a time, in order). Ids are a
  user avatar uuid or `official:<slug>`; `persona.libraryAvatarId` links the
  persona. The backend (`cohost_library.rs`) talks to videorc.com's
  `/api/buddy/*` routes (bearer; contract in videorc-web
  `docs/buddy-library.md`), caches pictures under
  `buddy-assets/library/<uuid>/<state>-<v>.png` and keeps the sync clock in
  the `buddyLibrarySync` settings row. With `cohost.buddyLibrary.enabled`
  false (signed out, or the web's storage unconfigured) the plan 169
  `/api/ai/cohost/avatar/set` path stays the look's fallback.
- `buddy:deep-link { openCreator }` is the main-to-renderer IPC event for
  `videorc://buddy` (`main/buddy-deep-link.ts`). The shell opens Avatar →
  Profile for it, and the creator when `openCreator` is set; a tab id in
  the same event picks the page (a Sidekick tab opens Sidekick, an Avatar
  tab opens Avatar; the two id sets never overlap).
- The `videorc-asset` scheme answers CORS reads for the `buddy` host, and
  the living preview loads those pictures with `crossOrigin`, so measuring
  a still picture's pixels never taints its canvas.

On stream (Phase C):

- The state machine is `crates/videorc-backend/src/buddy_overlay.rs`:
  `BuddyOverlayState {persona_id, state, bubble, generation}`, pure and
  clock-injected; one tokio sleep per bubble keyed on its generation.
  `buddy_overlay::show_bubble(app, text, state)` is the one way a bubble
  appears, and `show_for_utterance(app, &utterance)` is the gate in front of
  it (D7/D18): a `sent` utterance bubbles as it lands, a `bubble-only` one
  and the Say box bubble at once, an answer on its way to chat may show
  `think`, and nothing shows while the avatar's `showOnStream` and
  `showInRecording` are both off. `settle(app)` ends a `think` that never
  became a bubble; `clear(app)` runs at every session start. The bubble
  queue (plan 211 D7) lives there too.
- RPCs: `cohost.buddy.status` (observation),
  `buddy.overlay.set {target: 'primary' | 'auxiliary', pngBase64, rect}`
  (mutation, the captions slot shape; decoded off the async runtime) and
  `buddy.overlay.clear {target?}` (mutation, plan 168). Event
  `cohost.buddy.state {personaId, state, bubble: {text, until} | null}`.
- The pet is drawn by the backend (plan 168 Phase B,
  `crates/videorc-backend/src/buddy_sprite.rs`): the persona's pack (Alive)
  or its state images as a flat pack (Still) is pre-scaled per output leg
  into a BGRA atlas and drawn as one quad per leg by the CPU, Metal and
  D3D11 paths. The renderer pushes the bubble only.
- The proof surface (Windows idle, Linux) has no compositor leg, so the
  backend serves the avatar's layer on its own (plan 205 S9,
  `preview_buddy_layer.rs`):
  `GET /preview/buddy/latest.bmp?token=&canvasWidth=&canvasHeight=` draws
  the sprite slot's `Preview` leg (its own atlas) and the bubble into one
  straight-alpha BGRA BMP, with its rect in canvas fractions in
  `x-videorc-layer-rect`. It answers `204` to an unchanged cursor, and `204`
  with `x-videorc-layer-empty: 1` while the program does not carry the
  avatar. The Preview leg reads an output leg's frame clock while one has
  drawn in the last 500 ms, so the pet animates in step with the legs. Main
  (`main/preview-surface-buddy.ts`) places it above the banners and polls it
  apart from the source pollers, so it never counts toward source liveness.
- Renderer: `lib/buddy-overlay.ts` (lazy) lays out and paints the bubble per
  target canvas (`renderBuddyBubblePng`, its tail tip on the bitmap's
  bottom-centre, which the compositor puts on the pet's head) and the
  settings sample's avatar-plus-bubble composite;
  `lib/buddy-overlay-targets.ts` (eager, asset free) plans the targets and
  keys the push. The Studio pushes on every change of bubble, style,
  placement or canvas, session or not (the slot is app-global), and clears
  the slot when the bubble ends. Six paint-log snapshots in
  `lib/__snapshots__/buddy-overlay.test.ts.snap`.
- Stream Manager relay: `CohostWindowState.buddy?` (persona, state, bubble,
  `showOnStream`); `cohost-action` kinds `buddy-say {text, state}` and
  `buddy-show-on-stream {showOnStream}`; `buddy-say` carries the live
  `sessionId` when the window shows one, and the Studio routes it to
  `cohost.utterance.say` (so a manual line is one bubble-only utterance that
  shows at once, in every mode) and the switch to `overlays.layout.set`.
- Placement, the leg plan and the render paths are in
  [overlays.md](overlays.md).

Greetings:

- `cohostSettings.autoChat.greetings` is `{enabled, templates[], ai,
welcomes {firstTime, returning}}` (each welcome `{enabled, text?, state,
reaction?}`; plan 192 keeps welcomes out of `templates[]` so an older app
  never meets an unknown kind). Greetings (with AI and both welcomes) are
  on by default. Bad templates are refused with `cohost-auto-chat-invalid`
  (`cohost.rs::validate_auto_chat`). The rest of `autoChat` is Sidekick's
  ([buddy.md](buddy.md#for-developers)).
- `cohost_greetings.rs` holds the facts, the templates and the collapse;
  `note_activity` in `cohost.rs` greets with no Premium, no consent and
  Sidekick Live off (the test
  `ai_greetings_need_premium_consent_the_capability_and_the_switch` holds
  it).

Code (renderer, under `apps/desktop/src/renderer/src/`):

- `components/tabs/avatar-tab.tsx` (the page, a lazy chunk, with the status
  row) with `lib/avatar-tabs.ts` (ids `profile` and `greetings`, labels and
  the remembered tab; eager, so no icons and no components) and
  `lib/avatar-tab-view.ts` (where the avatar shows);
  `components/buddy-library-section.tsx`, `buddy-persona-section.tsx`,
  `buddy-pet-settings.tsx` (the Look section, `buddy-avatar-section.tsx`,
  with Reactions and Motion), `buddy-greetings-section.tsx`,
  `buddy-bubble-sample.tsx`, `buddy-onboarding.tsx`, `buddy-pet-creator.tsx`
  and `buddy-test-dialog.tsx`; in Stream Manager, `BuddyIdentity` and
  `BuddySayFooter` in `components/cohost-pane.tsx`, placed by
  `stream-manager.tsx` as the Avatar block.
- The page's sidebar row wears `AvatarPageIcon` (Phosphor Smiley); the
  avatar's own picture, else Flint's artwork, is `BuddyIcon` and
  `BuddyEmblem` ([icon-set.md](icon-set.md)).

Checks:

- `pnpm smoke:buddy-pet` imports a pack, wears it Alive, burns your avatar
  into a real recording and reads its reactions, gaze, talk and sleep back
  from the decoded frames.
- `cargo test -p videorc-backend cohost` covers the persona, the settings
  round trip with the name migration, the greeting engine and the bubble
  state machine; `cargo test -p videorc-backend buddy_official_catalog` the
  catalog.
- `pnpm smoke:live-chat-fake-providers` ends with the Bubble scenarios (plan
  211): with your avatar on stream and no lines of your own, a fake
  follow's built-in line and five first-time chatters across Twitch and
  Kick show as three bubble lines (the first welcome, a collapsed welcome
  for the burst, the follow), with zero sends and `said[]` in the report.
