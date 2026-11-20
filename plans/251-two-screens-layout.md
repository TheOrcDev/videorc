# Plan 251: Two screens on a talk show

The owner's ask (2026-11-19): "I want guests to be able to share their
screen and I can just put it in as a host on our live stream. … we can have
two screens side by side at the same time … we could play a game, for
example. One host can share what's from his side and the guest can share
what he is seeing … below those screen sharings, cameras of our people who
are inside of that studio."

Facts are read from desktop `origin/main` `7e00e28d2` and web `origin/main`
`cff5687c` (2026-11-19).

## Status and scope

- **Status: BUILT 2026-11-19, in review.** Desktop branch
  `feat/two-screens-layout`, web branch `feat/two-screens-layout`
  (`docs/plans/251-two-screens-layout.md` there; web PR TheOrcDev/videorc-web#165). Unit tests, typecheck, lint
  and the targeted Rust tests ran. The app smokes did not (see "Owed").
- **In scope:** managed talk shows (web control): the web's stage route,
  the program page, the guest page, the desktop backend, the renderer's
  stage model, and a fifth layout card with two-screen picking in plan 252's
  Show stage.
- **Out of scope:** the runner (`videorc-cloud`); the Rust UI
  (`videorc-rust`); captions; the controller and lease code; the room's Hide
  screen plate (merged meanwhile as #1558, used as it is); the room UI
  redesign (plan 252, merged meanwhile as #1559, built into at the point it
  names).
- **Number:** 251 is the next free number after 250 (248 is unused, 249 is
  cloud parity).

## What exists

- **A guest can already share a screen.** The host allows it per guest
  (Guests → ⋯ → Allow screen share: `guest-moderation.tsx`,
  `GuestAction::AllowScreenShare`, the web's `updateParticipant` publish
  permission). The guest page then shows Share screen on a desktop browser.
- **The stage names one screen.** `CloudStage { layout, onStage, spotlight?,
  screen?, hostShape? }`; the layout `screen-people` draws that screen large
  with the people beside it. The page drops a `screen` whose owner is not on
  the stage, and falls back to `side-by-side` while the screen has no fresh
  frame.
- **Putting a guest's screen on the program** arrived with plan 252 while
  this was in review: each shared screen is a card under Screens on the
  Show stage, and a card puts its screen on stage (`stageWithScreen`). One
  at a time. Before it, a managed show had no way to do it at all.
- **Where a stage is read**, and how strictly:

  | Reader | A layout it does not know | A field it does not know |
  | --- | --- | --- |
  | Rust `CloudStage` (status from the web, `cloud.stage.set`) | the whole room state fails to parse | ignored |
  | Renderer strict schema (`backend-rpc-contract.ts`) | the whole status is dropped | the whole status is dropped |
  | Web `parseStageBody` | 400 `invalid-request` | ignored |
  | Program page `readStageMetadata` | no stage: keeps the one it has | ignored |
  | Guest page `parseStageMessage` | (no layout in the message) | ignored |
  | Runner `StageSpec` (node shows) | the intent fails to parse | ignored |

## Decisions

### D1. The data model: one optional field, no new layout id

`CloudStage` gains `screens?: string[]`:

- absent, or exactly two different identities, both on `onStage`, with
  `screen === screens[0]`;
- the wire layout stays `screen-people`.

What is *drawn* is named `two-screens`, but only in reports of what was
drawn (`shown.layout`, a plain string every reader already drops when it
does not know it) and inside the two layout modules.

Why not a new layout id, as first sketched: the table above. A new id
hard-fails in four readers that an owner can meet in one evening: an older
desktop taking the show over (plan 243, "continue on another device") could
not parse the room state at all; a program page loaded before the web deploy
would freeze on its last stage; an old web would refuse the stage; the
runner would refuse the intent. A new *field* is ignored by every one of
them, and because `screen` stays the first of the pair they all draw a
sensible picture: one screen and the people. It also makes the rollout
order a preference, not a requirement.

The two known traps, and how each is closed:

- **Strict renderer contract.** `screens` is in `cloudStageSchema` and in
  the `shown` schema of `backend-rpc-contract.ts`
  (`arraySchema(boundedString, { maxLength: 2 })`, optional). Without it the
  renderer would drop every status of a two-screens show.
- **`null` on the wire.** Rust holds `screens: Vec<String>` with
  `#[serde(default, skip_serializing_if = "Vec::is_empty")]`, on
  `CloudStage` and on `CloudRoomShown`. It can never serialize `null` or
  `[]`. A test pins that a stage without a pair serializes byte for byte as
  before.

### D2. Who validates what

| Layer | Rule |
| --- | --- |
| Renderer `lib/stage-screens.ts` | builds only valid stages: each screen on stage, each once, at most two; `screen` first; `screens` only for two |
| Renderer `stageWith`, `stageInRoom` | prune a screen whose owner left the stage or the room; the other screen stays |
| Rust `CloudStage::validate` | `screens` empty, or two different identities, on stage, led by `screen` |
| Rust `set_stage` | refuses `screens` on a show that is not on web control (D6) |
| Web `parseStageBody` | the same pair rule: 400 for a wrong shape, 422 for an identity not in the room or not on the stage |
| Page `readStageMetadata` | anything that is not a pair is the one `screen` (never an error) |
| Guest `parseStageMessage` | the same: not a pair is the one `screen` |

### D3. The layout

Two screens across the top, each a 16:9 box (the picture is contained in
it, as on Screen + people); everyone on stage in one row under them.

- **16:9 output (1920×1080):** screens 922×518 side by side; the row under
  them is 490 px high: 2 people at 870×490, 3 at 608×342, 4 at 450×252, 5 at
  354×198, 6 at 292×164.
- **9:16 output (1080×1920):** the screens stack, each 1030×580, and the
  people take a grid under them: 1 or 2 in one row, 3 or 4 in two columns,
  5 or 6 in three.
- **Each screen over its owner's camera** (fix, 2026-11-20, after the third
  live test: "My screen recording is above the guest and the guest's screen
  recording is above me"). The screens were drawn in the order they went up
  (`screens`) and the cameras in stage order (`onStage`), so a guest who
  shared first had their screen over the host. Now the screen of whoever
  stands first on the stage is on the left (on top on a portrait canvas),
  in both models (`screensByOwner`), ordered by `onStage` so a screen keeps
  its side while its owner is away from the row. The wire is unchanged:
  `screen` is still the first one put up. With two people each screen is
  exactly over its owner; with more, the screens are in the same order as
  their owners in the row.
- **1 screen** (one of the two has no fresh frame for 5 s, or the host
  ticked only one): Screen + people, with that screen. **0 screens:** Side
  by side. A stage change waits 1 s for a named screen's first frame before
  falling back, as today, so adding the second screen does not flash through
  another layout. Changes crossfade in 300 ms, as every layout change.
- **3+ people:** up to 6 are drawn, as everywhere; past 6 the first 6.
- **The host's circle (`hostShape`):** applies to the host's camera tile in
  the row, unchanged. Screens are never circles.
- **Away and camera off:** per camera tile, unchanged ("Back in a moment",
  the camera-off circle). A screen owner whose camera is off keeps their
  screen up. Someone away for 60 s leaves the row; their screen stays while
  it has frames.
- **Hide screen** (plan 210 D8 in a room; desktop #1558 and web #166,
  merged 2026-11-19 while this was in review, and this branch is rebased on
  them): each of the two screens keeps its own. Only the host's screen has a
  privacy state, and every surface holds it per picture, never per layout:
  the program page on the host's `StageMedia`, the guest page in
  `PrivateScreenVideo`, the Show stage in `tileTrack`'s `still` for the
  host's screen tile. So the hidden screen draws its frosted still in its
  slot while the screen beside it stays live, and Show brings back only that
  one. Tests pin it on the Show stage (room view and Program preview) and on
  the program page's pictures.
- **A host's scene (plan 249 S12)** has one screen box: it shows `screen`,
  the first of the pair.

The geometry is code in both repos (desktop `talk-show-layout.ts`, web
`stage-layout.ts` `planTwoScreens`), held to one fixture,
`protocol-fixtures/talk-show-two-screens-layout.json` (1 to 6 people, three
canvases; copied to the web's `tests/fixtures/`). The runner's fixture
`talk-show-layout.json` and its pinned SHA are untouched.

### D4. Audio

Both screens' audio is heard: by viewers, by the recording and by guests.

- **Program and recording:** the page subscribes to the screen-share audio
  of both named screens and mixes each through the auxiliary gain and the
  limiter (`stage-audio.ts`), as it mixes one today. The host's audio
  routing (speech and auxiliary gain, mute) governs both. The cloud
  recording is the program.
- **Guests:** a guest hears the screen audio of each selected screen that is
  another guest's. The host's screen audio stays the one auxiliary track.
  A guest never hears their own.
- No per-screen choice in this plan. Two games at once is the case the owner
  described; a per-screen mute would be a new control (see "After").

### D5. Subscriptions

- **Program page:** `stageWantsTrack` wants the screen and screen audio of
  `stage.screens` (two, one or none) and of nobody else, so a third person
  sharing on stage costs the page nothing.
- **Guest page:** the stage message carries `screens`. The guest page shows
  each selected guest screen in that guest's tile (as it showed one), keeps
  the host's screen on its privacy-certified path with the host's camera in
  a tile of its own, and never shows a guest their own screen back.

### D6. Node shows

Refused explicitly, not built. The runner composes node shows from its own
layout table and has no two-screens layout; adding one is a change to a
private repo, its fixture and its release, for a path the owner does not
use (the owner runs managed shows).

- The Show stage offers one screen on a node show: the Two screens card is
  disabled with "This show puts one screen on the program.", and a Screens
  card takes the one place.
- The backend refuses `cloud.stage.set` with `screens` on a show that is
  not on web control, with that same line, before anything reaches the
  socket. Never narrowed silently.
- Everything else on a node show is byte for byte what it was: a stage
  without a pair serializes as before.

### D7. Host UX

Built into plan 252's Show stage (the room in pictures, merged as #1559
while this was in review), at the integration point that plan names. No
separate control.

- **A fifth layout card, Two screens**, with its diagram in
  `StageLayoutThumb`: two screens across the top, two people under them.
  - Choosing it puts up the screens the stage already names, then whoever
    else on stage shares one, up to two. With one screen it shows that one
    (the program draws Screen + people) and stays chosen, waiting for the
    second.
  - It waits with "Share a screen first" while nobody on stage shares one,
    said once under the cards for it and Screen + people.
  - On a node show it is disabled with "This show puts one screen on the
    program." (D6).
  - It is pressed while two screens are drawn, and while it is chosen with
    one up.
- **The Screens gallery picks up to two while Two screens is chosen.** Each
  shared screen is already a card there (`roomScreens`). A card on stage is
  pressed, so a pair shows two pressed cards. A click adds the card's screen
  beside the other, or takes it off and leaves the other. A third card is
  disabled with "Two screens are on stage. Take one off first."
- **On any other layout the gallery is plan 252's:** a card takes the one
  place, and Screen + people is one screen (choosing that card from Two
  screens takes the second one off).
- The host's own Share screen… goes beside the screen already up while Two
  screens is chosen, and takes the one place otherwise, as before. Stop
  sharing takes only the host's off.
- No success toast: the stage is the confirmation (owner call, 2026-07-16).

"Two screens is chosen" has no field on the wire (D1), so it is the
renderer's: set by the card, kept while Screen + people is up, and read back
from a stage that names two after a relaunch or on another computer
(`twoScreensChosen` in `lib/stage-screens.ts`, `talkShow.twoScreens`). With
one screen up after a relaunch the choice reads as Screen + people; one click
on the card chooses it again.

Where it lives: the rules are pure functions in `lib/stage-screens.ts`; the
view model in `lib/guests-view.ts` (`layoutOptions`, `selectedLayout`,
`roomScreens`, `stageWithScreenCard`, the widened `stageWithScreen`); the
choice in `use-talk-show-room.ts` (`setLayout('two-screens')`); the cards in
`show-stage.tsx` and `stage-layout-thumb.tsx`.

### D8. Rollout

1. Web first: merge and deploy. Old desktops never send `screens`; nothing
   changes for them (the stage key, the metadata and the state are
   identical for a stage without a pair).
2. Desktop: merge, then a release.

The order is safe either way: a new desktop against the old web would lose
only the second screen (the old route drops the unknown field and the page
draws one screen), and the Show stage would show what the page reports.

## Slices

In dependency order. Each leaves both repos working.

| # | Repo | Slice | Done when |
| --- | --- | --- | --- |
| W1 | web | `screens` in `StageSpec`, `parseStageBody`, the stage key | the route's refusal table and the shared key vectors pass |
| W2 | web | the page: `readStageMetadata`, `planTwoScreens`, `planStage`, `stageWantsTrack`, `shown` | every fixture case, the fallbacks and the subscription rule pass; `emit.ts --check` is clean |
| W3 | web | the report: `parseBeacon`, the stored page report, `buildRoomState` | a two-screens beacon reaches `state.room.shown` |
| W4 | web | the guest page: `parseStageMessage`, `guestScreenOwners`, audio | a guest sees and hears both selected guest screens, never their own |
| D1 | desktop | Rust: `CloudStage.screens`, `validate`, the frame, `CloudRoomShown.screens`, the node refusal, Remove | targeted `cargo test`, clippy and fmt pass |
| D2 | desktop | the contract and the model: `backend.ts`, the strict schemas, the stage key, `lib/stage-screens.ts`, `talk-show-layout.ts`, the fixture | unit tests pass; the fixture matches |
| D3 | desktop | the hook and the room client: prune, the stage message, `setLayout('two-screens')`, share and stop | unit tests pass |
| D4 | desktop | the fifth layout card and two-screen picking in plan 252's galleries | unit and component tests pass; by eye in both themes (owed) |
| D5 | desktop | the wire contract (`managed-media-wire.md` 6.1.1), the parity script's mirror | `pnpm test:scripts` passes |

## Tests per layer

- **Rust** (`cloud_talk.rs`, `cloud_show.rs`): the old wire shape is
  unchanged; the pair rule; `drop_screen`; a managed show sends both screens
  to `PUT …/stage` and its status carries them; a node show refuses.
- **Desktop unit:** `stage-screens.test.ts` (every rule of the model),
  `guests-view.test.ts` and `guests-view-room-ui.test.ts` (the fifth card,
  the selected card, the Screens cards), `show-stage.test.ts` (the tiles in
  the room view and the Program preview, the cards, a hidden screen frosting
  alone), `talk-show-layout.test.ts` (18 fixture cases, even and apart, the
  fallbacks, what the program reports), `talk-show-managed.test.ts`,
  `talk-show-room.test.ts` (the stage message), `use-talk-show-room.test.ts`
  (prune), `cloud-presentation-views.test.ts` (key vectors).
- **Scripts:** `cloud-parity-views-contract.test.mjs` (the third mirror of
  the key).
- **Web:** listed in the web notes.

## Owed

- `pnpm smoke:cloud-talk-show` and its managed variant
  (`smoke-cloud-talk-show-managed-app.mjs`), required by `AGENTS.md` for
  `cloud_talk.rs`, `use-talk-show-room.ts` and the Show stage. Not run: the
  Mac was at load 34 with swap nearly full, and the owner asked for the PRs
  merged first and one full pass on main afterwards. Neither smoke has a
  two-screens step yet; add one (two fake screen tracks, pixel probes at
  both screen tiles' centres) with that pass.
- A browser run of the program page with two screen tracks, and the guest
  page with two guest screens.
- The fifth card, its diagram and two pressed screen cards by eye, light and
  dark (owner feedback "Check both themes").
- A release, after the web deploy.

## After

- A per-screen mute for screen audio, if two games at once is too loud.
- Swap left and right without unticking.
- Two screens on node shows, if node shows come back into use: a runner
  layout, its fixture cases, and lifting the refusal in D6.
- The Rust UI (`videorc-rust`) gets the card in its own pass.
- A field for "Two screens is chosen", if the choice should survive a
  relaunch with one screen up.
