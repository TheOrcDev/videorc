# Plan 252: The room UI, in pictures

The owner's ask (2026-11-19): "that whole UI when we open a room inside of
Studio is really weird. It's only text. It's not really graphical. It's not
following our UI/UX from the rest of the app. I want you to plan that one out
differently, to use best practices for UI, and to rebuild it."

Facts are read from `origin/main` `7e00e28d2` (2026-11-19), after #1555 (the
three mic states) and #1556.

## Status and scope

- **Status: BUILT 2026-11-19, in review.** One PR, branch
  `feat/room-ui-redesign`. A presentation rebuild: the same actions, the same
  RPCs, the same data. Two things are new, both asked for (see "What
  changes in behaviour").
- **In scope:** everything on screen while a talk show's room is open.
  - The Show stage in the Studio (`components/studio/show-stage.tsx`): the
    stage well, the layouts, the screen share, "wants to join", the people,
    the Program monitor and its lines.
  - The Guests page (`components/guests/guests-tab.tsx`): the room, the
    invite link and the door, "On the program", and who is here.
  - Their shared parts: `components/guests/room-person.tsx` (new),
    `components/studio/stage-layout-thumb.tsx` (new),
    `components/guests/guest-moderation.tsx`, and the view models
    `lib/guests-view.ts` and `lib/room-program-opt-ins.ts`.
- **Out of scope:** the stage logic in `hooks/use-talk-show-room.ts`
  (`stageWith`, `stageInRoom`, `setStage`), the room's media
  (`lib/talk-show-room.ts`), captions, Rust, the guest's own page (web), the
  Studio's Guests session row, Separate files (`cloud-iso-section.tsx`), and
  the Rust UI (`videorc-rust`), which gets its own pass.
- **Number:** 252. 250 is the notification center; 251 is left for the
  two-screens layout in flight. Rename this file if another plan takes 252.

## What was wrong

Described from captures of `origin/main` (kept outside the repo, see
"Seeing it").

**The Show stage**

1. Under the picture, everything was words. The four layouts were a row of
   text chips ("Solo", "Side by side", "Screen + people", "Spotlight") while
   the Studio's own Scenes are cards with a diagram.
2. The people were one flat list, "In the room", of 28 px rows. Who is on
   stage and who is backstage was told only by which text button the row had
   ("Send backstage" or "Bring on"). The picture of each person was 36 × 20
   px.
3. Each row ended in words and unlabelled marks: a text button "Mute" or
   "Unmute", a ⋯, then a bare waveform glyph, and sometimes a bare coloured
   dot with no word. "Muted by you", "Mic off" and talking were the same
   glyph with a different tooltip.
4. "Bo wants to join" was a full-width yellow warning panel per person,
   three of them stacked, sitting between the controls and the list. Nothing
   else in the app tints a panel to ask a routine question.
5. The Program monitor floated at a third of the width with dead space
   beside it, its state ("Unconfirmed") as a video pill on the picture, and
   under it a sentence as a link: "Avatar off · Graphics off >". The output
   profile was a 40-word sentence in the middle of the panel.
6. A guest's screen share could only be allowed from the ⋯ menu ("Allow
   screen share"). Nothing on screen said a guest could share at all, whether
   they were allowed, or that they were sharing. There was no way in the UI
   to put a guest's shared screen on the program.

**The Guests page**

7. A settings form: label, sentence, control, five times over. The room's
   state was the two words "Room open".
8. "Who's here" was names and words only: "On stage" or "Backstage" as a
   chip on every row, "Good connection" spelled out on every row, no
   pictures, and the mute and the screen share hidden in ⋯.
9. The invite link was a bare field with two text buttons, and the door
   switch (which is about the link) sat in another section.

## The design

The rule: **a picture or an icon says the state; a word is kept only where
two states would otherwise look alike; the sentence is the tooltip.** Every
pattern below already exists in the local Studio, so the room reads as the
same app.

### Information architecture

One home per control, as before; nothing moved between pages except the door
switch (within Guests).

| Thing | Its one home |
| --- | --- |
| The picture: layout, which screen is on stage, Bring on, Send backstage, Spotlight | Show stage |
| The host's own screen share (Share screen…, Stop sharing) | Show stage → Screens |
| The room: Open, Close, the link, New link, the door | Guests (Close also on the Show stage's header, as before) |
| On the program: Avatar, Graphics | Guests → Room; the Show stage shows two chips that open Guests |
| A guest: mic hold, screen share, Rename, Remove, Ban | The guest's row, the same row on both pages (as the moderation kit was shared before) |
| Let in, Decline | The request's row, on both pages (as before) |
| Record, Go Live, End | The inspector's transport: the room UI never repeats them or says "live" |

### The Show stage

Top to bottom:

1. **Header**: "Show stage", the line the lifecycle probe reads, and Close
   the room. Unchanged.
2. **The stage well**: the room's picture, unchanged in geometry. Name plates
   now carry the voice: a muted-mic glyph when that person can't be heard
   (their own mute or the host's hold), a green dot while they talk.
3. **A device problem**, when there is one: the warning alert, as before.
4. **Wants to join**: a labelled list with a pulsing amber dot and a count.
   One row per request: a letter avatar, "Bo wants to join", a phone or
   computer icon (tooltip: "On a phone"), Let in, Decline. Three at most,
   then "1 more wants to join >" to Guests. Above everything else because it
   waits on the host.
5. Two columns from 44 rem; one column below that, with the Program first.
   - **Left: what goes on the picture.**
     - **Layout**: four cards with a diagram each, the Scenes gallery's
       `SceneCard`. The layout in use is the selected card with a check. A
       layout that can't apply is dimmed and says why on hover; the one line
       under the cards says it for all, as before.
     - **Screens**: every screen shared in the room as a card with its live
       picture ("Your screen", "Ada's screen"). The card on stage is
       selected; a click puts a screen on stage or takes it off. The
       section's action is Share screen… / Stop sharing. With no screen:
       "Nobody is sharing a screen. A guest can share theirs once you allow
       it on their row."
     - **On stage** and **Backstage**: two lists with counts. 40 px rows.
       With nobody backstage, one quiet line and a door to the invite link.
   - **Right: what the cloud sends.** The **Program** monitor: its name, its
     state as a chip beside the name (Confirmed green, the rest amber,
     Takeover neutral; the sentence on hover), the speaker (node shows) and
     ⋯ (Videorc Camera) at the end. Under the picture: two chips, "Avatar
     on" and "Graphics off", one button that opens Guests; then the output
     profile as "1920×1080 · 30 fps · 6 Mbps" with the whole sentence on
     hover (amber when the room sends something other than the settings).
     News stays in words under it, as before (a refusal, the scene, Videorc
     Camera).

### A person's row (both pages)

Left to right:

1. **Their picture**, 50 × 28 px, live. Camera off or no picture yet: the
   letter the viewers see. A green rim while they talk.
2. **Their name.**
3. **What is wrong, only when something is**: an amber or red dot for a weak
   or lost connection (a good one draws nothing), "Away" (amber chip), and
   "Muted by you" or "Mic off" as a chip, each with its sentence on hover.
   These two keep their words because as icons they look alike (#1555).
4. **Mic**: one icon toggle. The icon is the state (waveform, green while
   talking; struck waveform when it can't be heard). Pressed means muted, as
   the mixer's mute buttons: the host's hold on a guest, or the host's own
   mute. Its name is what a press does: "Mute Ada", "Let Ada unmute".
5. **Screen share** (guests): one icon toggle with three states. Not
   pressed: not allowed. Pressed: allowed. Pressed with a green dot: sharing
   now. Its name is what a press does; the tooltip says the state.
6. **The stage move** (Show stage only): "↑ Bring on" or "↓ Send backstage".
   These keep their words: they are the room's two verbs.
7. **⋯**: Spotlight, the host's camera, Rename…, Remove…, Ban….

### The Guests page

- **Room**: one row with a status dot (green when open, pulsing while
  opening or closing), the phase, the room in numbers as chips ("3 want to
  join" amber, "2 on stage", "1 backstage"), and Open or Close the room.
  Under it, what the room sends as chips, with the sentence on hover; before
  the room opens the sentence stays, since it can be the reason the room
  can't open.
- **On the program** (managed shows): Avatar and Graphics each with an icon
  and, once on, a dot for how it stands (green applied, amber waiting, red
  refused). The description is unchanged, word for word.
- **Invite link**: the link in a field with a link icon, Copy (the icon
  turns into a check), New link, and the door switch under them, since the
  door is about the link. The consent line stays.
- **Who's here**: Wants to join, On stage, Backstage, the same rows as the
  Show stage without the stage move. Empty: one centred line.

### States

| State | What shows |
| --- | --- |
| Room closed | Guests: grey dot, "Room closed", Open the room; the link field says it appears when the room opens; switches off with "Open the room first." |
| Locked (Basic, rollout, offline, a local session) | The existing lock alert leads Guests; every control disabled |
| Opening, closing | Pulsing dot, the spinner in the button |
| Joining, reconnecting | The pill with a spinner on the stage well, as before |
| Nobody yet | Stage: the host alone On stage, Backstage's empty line with the door to the invite link. Guests: one centred line |
| Requests | "Wants to join" list with its count and amber dot on both pages; an amber chip on the Room row |
| On stage, backstage | The two lists; the stage move on the Show stage |
| Talking | Green rim on the picture, green waveform, green dot on the name plate |
| Muted by you | "Muted by you" chip, struck waveform, the toggle pressed; a muted glyph on the name plate |
| Mic off (the guest's own) | "Mic off" chip, struck waveform, the toggle not pressed |
| The host muted | The host's toggle pressed with the struck waveform; a muted glyph on "You" |
| Camera off, no picture yet | The letter in the row's picture and on the stage tile |
| Away | "Away" amber chip on the row; "Back in a moment" on the tile, as before |
| Weak or lost connection | Amber or red dot beside the name |
| Screen share: off, allowed, sharing | The row's toggle; a sharing screen is also a card under Screens |
| A screen on stage | Its card selected; "Screen + people" is the selected layout |
| Stage full | Bring on disabled with the reason on hover, as before |
| Not live | Program: the empty frame and its line, as before |
| Live or recording, managed show | Program preview with its state chip, the two opt-in chips, the output profile chips |
| Live, node show | Program (the return) with its speaker; no opt-in chips |
| Takeover | "Takeover" chip beside the Program's name |

### Interaction rules

- Every action calls what it called before. A row's mic toggle is the old
  Mute / Unmute button; Unmute still raises the one info toast "Ada can talk
  again once they unmute." (#1555). No new toast.
- Choosing the layout already in use sends nothing, as the segmented control
  did.
- Destructive actions still ask first (Remove…, Ban…, Close the room, New
  link with guests in the room).
- A disabled control always says why on hover and on focus
  (`DisabledReason`).

### What changes in behaviour

1. **A guest's screen share is a control on their row**, not a ⋯ item
   (the same `cloud.guest.act` actions). Mute left the ⋯ menu too: it is the
   row's mic toggle.
2. **A shared screen can be put on stage from its card.** It sends the same
   stage a host's own share sends (`setStage` with `layout: 'screen-people'`
   and `screen: <identity>`), and taking it off mirrors Stop sharing
   (`stageWithScreen` in `lib/guests-view.ts`, pure and tested). Before, a
   guest's screen reached the program only when the runner picked it.
3. The door switch moved from Guests → Room to Guests → Invite link.

### Room left for the two-screens layout

`feat/two-screens-layout` adds a layout that shows two screens. It fits
without a redesign:

- **The layout**: a fifth `SceneCard` in the Layout gallery; add its diagram
  to `StageLayoutThumb`. The grid wraps.
- **Picking the screens**: the Screens gallery is the one list of shared
  screens (`roomScreens`). `RoomScreen.onProgram` becomes true for each
  screen the stage names, so two cards are selected; the card's click adds
  or removes its screen. `stageWithScreen` is the one function to widen.

### Accessibility

- Every icon-only control is a real button with a name that says what a
  press does, `aria-pressed` for its state, and the state in words for a
  screen reader (`sr-only`). Status icons carry `role="img"` and a label.
- Tooltips open on keyboard focus (`InfoTooltip`, `DisabledReason`) and
  their text stays in the DOM as the control's description.
- Tab order follows reading order: requests, layouts, screens, people,
  Program. Lists are labelled groups ("Wants to join", "On stage",
  "Backstage", "Layout", "Screens").
- Colour is never the only signal: talking is also the waveform's label,
  muted is also the struck glyph and the chip, a weak connection is also the
  dot's label.

### Light and dark

Only tokens and existing primitives are used (`SceneCard`, `MediaCard`,
`GroupedList`, `ListRow`, `Badge`, `Toggle`, `StatusDot`, `InputGroup`,
`SettingsRow`, `Empty`, `KebabMenu`), so light is the same structure with
the light column. The video ground stays dark in both themes, as the Preview
does. Every state above was captured in both.

### Components

| Surface | shadcn components |
| --- | --- |
| Layout, Screens | `SceneCard` (on `MediaCard`), `Badge` (the check), `Button`, `Dialog` (the picker, unchanged) |
| Requests, people | `GroupedList`, `ListRow`, `Avatar`, `Toggle`, `Badge`, `Button`, `KebabMenu` (`DropdownMenu`), `Tooltip` |
| Program | `Badge`, `Button`, `KebabMenu`, `Tooltip` |
| Guests | `PanelSection`, `FieldGroup`, `SettingsRow`, `InputGroup`, `Switch`, `Badge`, `Empty`, `Alert` |

No new primitive, no new icon (the set is licence-counted), no new
dependency.

## Slices

Built as one commit; each slice has its own check.

| # | Slice | Done when |
| --- | --- | --- |
| S1 | View models: `personMicView`, `micToggleLabel`, `guestScreenShare`, `roomScreens`, `stageWithScreen`, `roomCounts`, `outputProfileChips`, `roomProgramChips`, `roomOptInTone` | `lib/guests-view-room-ui.test.ts` passes |
| S2 | The shared row: `room-person.tsx` (`PersonRow`, `PersonThumb`, `MicToggle`, `ScreenShareToggle`, `RequestRow`), moderation kit without Mute and screen share in ⋯ | The row tests in both component suites pass |
| S3 | Show stage: Layout cards, Screens, Wants to join, On stage / Backstage, name-plate voice | `show-stage.test.ts` passes; every old test id still resolves |
| S4 | Program monitor: state chips, opt-in chips, output profile chips | The Program tests pass unchanged |
| S5 | Guests page: Room row, On the program, Invite link with the door, Who's here | `guests-tab.test.ts` passes |
| S6 | By eye, light and dark, every state | Captures reviewed |
| S7 | Gates | typecheck, lint, format, renderer budget |

Test ids kept: `show-stage`, `show-stage-well`, `show-stage-tile`,
`show-stage-plate`, `show-stage-program` and its children,
`show-stage-requests`, `show-stage-request`, `show-stage-strip`,
`show-stage-strip-row`, `show-stage-mute`, `show-stage-bring-on`,
`show-stage-send-backstage`, `show-stage-share`, `show-stage-stop-share`,
`show-stage-output-profile`, `show-stage-layout-reasons`, and every
`guests-*` id. The scripts that read them (`smoke-cloud-talk-show*`,
`cloud-parity-*`, the lifecycle probe) need no change. The layout chips'
`role="radio"` is gone: no script used it.

## Seeing it

The dev app needs a backend build, and the host was too loaded for one, so
the captures come from the real components in headless Chrome, served by
Vite with `@/hooks/use-studio` stubbed (the unit tests' own seam) and fake
camera tracks. Six scripted rooms (alone, joining, requests, a full live
managed show, a node show with a screen, trouble), the closed and locked
Guests page, at 900 px and 560 px, in dark and light. Captures and the
harness live in `~/videorc-incident-2026-11-19/room-ui/` (`before/`,
`after/`, `harness/`), never in the repo.

## Owed

- `pnpm smoke:cloud-talk-show` (and the managed twin): not run, by the
  coordinator's call to keep the host free. They run on main after the
  merge.
- A by-eye pass in the real dev app (the window's glass, the Studio's
  column widths, real cameras), with `window.__videorcSmokeScriptTalkShow`.
- A real room: a guest sharing a screen, put on stage from its card.
- The Rust UI port.
