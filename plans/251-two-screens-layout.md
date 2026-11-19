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
  stage model and one new control in the Show stage.
- **Out of scope:** the runner (`videorc-cloud`); the Rust UI
  (`videorc-rust`); captions; the controller and lease code; the room's Hide
  screen plate (`fix/room-hide-screen-plate`); the room UI redesign
  (`feat/room-ui-redesign`).
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
- **Nothing on the desktop puts a guest's screen on the program.** On a
  managed show `stage.screen` is set only when the host starts their own
  share (`startScreenShare`) or when a scene needs a screen
  (`cloud-scene-adapter.ts`). The page shows no screen the stage does not
  name. So a guest's share was visible in the room and never reached
  viewers. (A node show's runner picks the first shared screen on its own.)
  This plan's picker closes that gap too.
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
- **Hide screen:** only the host's screen has a privacy state. The page
  holds it per screen publication and draws the frosted plate on that
  screen's picture in whichever slot it sits, so the promise holds in the
  two-screens layout with no new code. The room-side plate fix is
  `fix/room-hide-screen-plate`; this plan does not touch that code, and the
  Show stage's screen tiles here go through the same `tileTrack` path that
  branch fixes.
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

- The Show stage offers one screen on a node show: the picker says "This
  show puts one screen on the program." and a tick replaces the other.
- The backend refuses `cloud.stage.set` with `screens` on a show that is
  not on web control, with that same line, before anything reaches the
  socket. Never narrowed silently.
- Everything else on a node show is byte for byte what it was: a stage
  without a pair serializes as before.

### D7. Host UX

One new control in the Show stage, beside Share screen…: **Screens on the
program**, a menu of checkbox rows.

- A row for everyone on stage who shares a screen now ("Your screen",
  "Ada's screen"), and for any screen the stage still names.
- Tick one: the layout becomes Screen + people with it. Tick a second: the
  two-screens layout, in the order ticked (first on the left). Untick the
  last: Side by side. A third row is disabled with "The program shows two
  screens at most. Take one off first."
- The host's own Share screen… puts it up as before, now beside a guest's
  screen that is already up; Stop sharing takes only the host's off.
- The Screen + people chip stays selected for both looks; there is no fifth
  chip. Shown only while there is something to pick.
- No success toast: the stage is the confirmation (owner call, 2026-07-16).

**Integration point for the room UI redesign:** the control is one file,
`components/studio/stage-screens-picker.tsx`, with no state of its own. It
takes `talkShow` and a `disabled` flag and reads the cloud status. It is
mounted by one line in `StageControls` in `show-stage.tsx`; the redesign can
move that line anywhere a `talkShow` is at hand. Its rules are pure
functions in `lib/stage-screens.ts`; its one action is
`talkShow.setProgramScreen(identity, shown)`.

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
| D3 | desktop | the hook and the room client: prune, the stage message, `setProgramScreen`, share and stop | unit tests pass |
| D4 | desktop | the picker in the Show stage | typecheck, lint; by eye in both themes (owed) |
| D5 | desktop | the wire contract (`managed-media-wire.md` 6.1.1), the parity script's mirror | `pnpm test:scripts` passes |

## Tests per layer

- **Rust** (`cloud_talk.rs`, `cloud_show.rs`): the old wire shape is
  unchanged; the pair rule; `drop_screen`; a managed show sends both screens
  to `PUT …/stage` and its status carries them; a node show refuses.
- **Desktop unit:** `stage-screens.test.ts` (every rule of the picker and the
  model), `talk-show-layout.test.ts` (18 fixture cases, even and apart, the
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
- The picker by eye, light and dark (owner feedback "Check both themes").
- A release, after the web deploy.

## After

- A per-screen mute for screen audio, if two games at once is too loud.
- Swap left and right without unticking.
- Two screens on node shows, if node shows come back into use: a runner
  layout, its fixture cases, and lifting the refusal in D6.
- The Rust UI (`videorc-rust`) gets the picker in its own pass.
