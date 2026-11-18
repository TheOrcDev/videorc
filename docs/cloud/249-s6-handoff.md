# Plan 249 S6: room, program and guest views

Status: implementation complete, live acceptance **not run**. Nothing here is
evidence of encoded output. Production qualification stays false. This is the
S6 checkpoint, not the completion of Plan 249.

## Paired branches

- Desktop: `/Users/orcdev/projects/videorc-wt-249-s6`, `feat/249-s6-cloud-parity`,
  restacked on S16 `5b340c09c` (`feat/249-s16-cloud-parity`). S16 contains S4
  `6a142e936` and S3 `a93168fc4`.
- Web: `/Users/orcdev/projects/videorcweb-wt-249-s6`, `feat/249-s6-cloud-parity`,
  restacked on S16 `78586c99` (`feat/249-s16-cloud-parity`). S16 contains S4
  `9f708259` and S3 `a68454e0`.
- S16 is an integration base, not a product dependency. S16 and its published
  prerequisites are being merged into `main`, and the coordinator publishes S6
  against `main`, so the S16 diff does not show up in S6.
- Both branches are uncommitted. The coordinator commits, cross-links and opens
  both PRs. There is no issue URL for S6.
- S5 (animation) and S9 (static graphics) are separate siblings. Their merge
  notes are below.
- Backups of the S4-based tree, taken before the restack, are in
  `~/s6-scratch/pre-s16/` (tracked patches, untracked tars).
- The restack had one conflict: the parity case list in
  `scripts/smoke-cloud-parity-app.mjs`. It now keeps both S16's `lifecycle` case
  and S6's `views` case. The other hunks S6 and S16 share (`use-talk-show-room.ts`,
  `backend.ts`, `cloud_talk.rs`) merged on their own.

## What each surface says it shows

| Surface                                 | Source label               | What it draws                                                                                                                                                                                           |
| --------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Show stage (desktop)                    | `room-tracks`, "Room" chip | The room's own tracks, at room latency. Never called the program.                                                                                                                                       |
| Program preview (desktop, managed show) | `program-page-report`      | The stage the program page reports drawing, redrawn with the shared geometry, plus S4's avatar layer. A badge says Confirmed, Updating, Unconfirmed or Out of date. A guest row reports guest graphics. |
| Program (desktop, node show)            | `runner-return`            | The runner's return, unchanged.                                                                                                                                                                         |
| Guest page (web)                        | guest projection           | People; the host's privacy-certified screen (S2); the on-stage guest screen the program shows; and, once the host opts in, the stream's public avatar and bubble at the program's geometry.             |
| Agents (`get_picture` in a room)        | `program-page-report`      | No pixels. An allowlisted projection: roles, normalized tile rects, layout, stage state and `encodedOutput: false`.                                                                                     |

## Contracts

- **Shared pure module.**
  - Desktop `apps/desktop/src/shared/cloud-presentation-views.ts` and web
    `lib/cloud/program/presentation-views.ts` export the same functions:
    `tileFit` (people cover, screens contain), `fitBox`, `fitScale`,
    `canonicalStage` and `stageKey` (FNV-1a 32, 8 hex characters).
  - The web module is emitted to `public/cloud/program/v1/presentation-views.js`.
  - The test vectors are in `protocol-fixtures/cloud-parity-views.json`, mirrored
    to web `tests/fixtures/cloud-parity-views.json`.
- **Screen contain.**
  - The program page contains screen tiles and covers camera tiles.
  - On the guest page, `TrackVideo` contains screens and covers cameras. The host's
    private screen video is marked `data-fit="contain"`.
  - The desktop Show stage uses `tileFit`.
- **Applied-stage acknowledgement.**
  - The beacon's `shown` gains optional `layout` and `stage` (an 8-hex key). The
    web keeps both only when valid.
  - Room state sends `shown.layout`, and sends `shown.stageKey` only together with
    `shown.at`.
  - The desktop's `CloudRoomShown` treats `layout`, `stageKey` and `at` as plain
    bounded strings. Rust passes them through.
  - `programPreviewStage` returns one of: empty, waiting, applied, updating,
    unconfirmed, or stale (no report for 25 s). This is the page's
    acknowledgement only.
- **Guest screen.**
  - The `videorc.stage` message always carries `screen`.
  - `guestScreenOwner` shows only the selected on-stage guest screen, never the
    host's (that stays on S2's path) and never the guest's own.
  - The selected screen's audio is played once. The host's `screen_share_audio`
    is heard only as S3's exact auxiliary track.
- **Guest public graphics (D4), now a working lane.**
  - **Lane rule.** `room-media-v2.ts`, desktop and web, adds
    `GUEST_GRAPHICS_LANE = {output:'stream', orientation:'h'}` and
    `graphicsLaneAllowed`. `parseConsumerCapability` accepts `graphics` from a
    `g_` identity only on that lane. `EG_` consumers are unchanged.
    `parseAvatarCapability` is untouched, so S5's `animation` and S9's `static`
    fields pass through.
  - **Server.** `relayMediaCapability` drops graphics unless the caller names an
    allowed lane. The guest cookie route (`handleGuestMediaCapability`) names
    `GUEST_GRAPHICS_LANE` only after it has checked that the guest:
    - owns the cookie and the request,
    - is present and admitted,
    - belongs to this show and invite,
    - holds the current participant SID (the relay checks the SID).

    An `applied` confirmation from an older host session is stripped.

  - **Host.**
    - `RoomAvatarPublisher.guests(on)` is the host's opt-in. It is off by default,
      per room, and set with `TalkShowRoomClient.setAvatarGuests` or the
      context's `setAvatarGuests`.
    - Guests get `content.h`, and only while the stream shows the avatar. A
      recording-only avatar never reaches a guest.
    - Turning guests off, or switching to recording only, sends one empty
      snapshot to each guest that was shown layers.
    - Guests never count toward the egress `state`. The status adds
      `guests: {enabled, capable, applied}`.
  - **Guest page.**
    - `GuestGraphicsReceiver` (`components/guest/guest-graphics.ts`) reuses
      `createAvatarView` and `AvatarReceiver` unchanged.
    - Before reading anything, it checks that the stream comes from the current
      host SID. It also bounds the stream's size and read rate, and parses only
      for the guest lane and the public `avatar` and `bubble` layers.
    - It clears the layers when the host's session changes, the lease runs out,
      the host sends a clear, or the guest leaves the room.
    - It confirms the painted revision through the capability within the 2.5 s
      throttle.
    - `GuestGraphicsLayer` draws it in a 16:9 contain box over the call stage. The
      box never takes a click.
    - `GUEST_GRAPHICS_PRODUCTION_QUALIFIED = false`.
  - **UI.** In the Program preview, a row under the avatar status (shown only
    while the avatar is on) reads "Guests don't see the avatar", "Shown to guests
    · N of M confirmed" or "Guests see the avatar". Its ghost `Button` is labelled
    "Show to guests" or "Hide from guests".
  - **Fixture hook.** The renderer hook `roomAvatarGuests(enabled?)` lets the
    maintained case drive the guest opt-in.

- **Agents.** `agentRoomProgram`, through `lib/agent-room-program.ts`, feeds the
  allowlist in the agent surface. Rust `room_program_outcome` copies an
  allowlisted subset and forces `encodedOutput: false`.

S2's source and privacy gates are unchanged, as are S3's aux handling (by SID,
role and receipts) and S4's avatar consent and status. Guests advertise no
`animation`, so they get S4's static fallback. Nothing new is on by default.

## Maintained acceptance, not executed

`pnpm smoke:cloud-parity -- --case views` (`scripts/lib/cloud-parity-views.mjs`)
checks:

- **Stages.** Three stages are applied by key, and the Program preview says
  `applied`.
- **Person geometry.** Each person marker on the real program frame sits at the
  shared-geometry rect, within 3% and filling its box.
- **Card.** The card lands at its normalized rect.
- **Guest views.** Guests see the other people on stage and never themselves.
- **Real screen fixture (new).** A solid 4:3 `getDisplayMedia` canvas, from the
  host and then from guest1:
  - The program frame's screen box equals `containRect(tile, 640×480)`, so it is
    pillarboxed and not cropped.
  - The other guest pages decode the whole 4:3 frame in its colour.
  - guest1 never gets its own screen back.
- **Guest graphics (new).** The avatar is prepared with S4's fixture pack before
  the program page joins, and the stream lane of `EG_parity_baseline` is
  authorized.
  - Nothing reaches a guest by default, yet both guest pages count as capable.
  - After the opt-in, both guests confirm the revision. Each draws the program's
    layers (the same kinds and rects) from decoded avatar pixels. The program
    frame draws the avatar inside its rect, and the monitor row reads "Guests
    see the avatar".
  - Switching to recording only clears the guests.
  - Opting out clears them within 5 s.
- **Returns.** Returns are mix-minus, with one soundboard copy.

The fixture's guest `/media` route now passes the guest lane, as production
does. The baseline prepares the avatar for `views` too.

The guest fixture pages load no Tailwind, so guest geometry is checked by DOM
contract (`data-fit`, inline layer rects) and decoded frames, not by guest page
pixels. The case says so in `report.views.guestLayout`. The guest screen's audio
is not covered: the canvas fixture has none, and the unit tests cover it.

Deferred by the user until all merges are on main: this case and every smoke,
real-page, device and browser (WB) suite; remote-control smokes; preview probes;
full builds; full desktop and web suites; Rust compile, test and clippy; advisory
audits; managed or paid output; and platform acceptance. The ledger and
`protocol-fixtures/cloud-parity-{plan,inventory}.json` were not edited. The S20
ledger owner flips the S6 rows after acceptance.

## Merge notes for siblings

- **S5 (animation, G7m82).**
  - In `show-stage.tsx`, keep both adjacent additions, in this order: avatar
    status, S5's `show-stage-avatar-animation` span, then S6's
    `show-stage-guest-graphics` row.
  - In `talk-show-room.ts` `#bind`, `this.#avatar.guests(this.#avatarGuests)`
    goes after S5's `#publishAvatar` change.
  - S5's `motionTargets` and `motionCoverage` count `EG_` peers only. Widen them
    to the lane rule when guest pages advertise `animation: 1`.
- **S9 (static graphics, G6oxv).** S9's relay change edits the `applied` and
  `static.applied` blocks just below the S6 lane line, so expect an
  adjacent-line merge at most. S6 never touches `parseAvatarCapability`.
- **S10 (G6ltc).** It imports the web `presentation-views.fitBox`, which is
  frozen. Future changes will be additive only.

## Focused evidence (lightweight only)

- Desktop renderer and node TypeScript projects: pass.
- Desktop Vitest, 12 files: 295 pass. The 11 listed below pass 289, and
  `use-talk-show-room` passes 6.
  - Files: presentation views, cloud avatar, avatar publisher (new guest-lane
    tests), aux publisher, talk-show managed/room/layout, agent surface, Show
    stage (new guest-row test), room join, RPC contract.
- Desktop `scripts/lib/cloud-parity-*.test.mjs`: 25 pass. These include new
  vectors for `containRect`, `assertInside` and `assertSameLayers`.
  `node --check` passes on the views, baseline and browser scripts.
- Prettier, oxlint (one existing warning in `use-studio.tsx:19876`, not S6), the
  em-dash gate and rustfmt (edition 2024) on the touched Rust: pass. Rust was not
  compiled.
- Web `tsc --noEmit`: pass.
- Web focused node tests: 71 run, 70 pass.
  - Files: guest graphics (new), cloud avatar, room media v2, guest shared
    screen, presentation views, guest page, managed talk.
  - The one failure, "end: no feed never ends a talk show…", expects no
    `providerLifecycle`. It also fails on the untouched S16 base `78586c99`.
- Web `cloud-invites` route tests (new guest-lane authorization and the existing
  media v2 case): 2 pass.
- Web ESLint on `components`, `lib/cloud` and the touched tests: 0 errors (4
  existing warnings in other files). Prettier and emitted-module `--check`: pass.
  `room-media-v2.js` was regenerated.
- Shadscan (cached `@shadscan/cli` 0.1.0-rc.7, `--json`): desktop baseline 27 on
  S16, floor 27, final 27; web baseline 47 on S16, floor 47, final 47. Advisory
  only: this thread created no commit.

## Desktop PR ready

Title: Plan 249 S6: Align room, guest and program views

Body: Label the Show stage as the room view and the managed monitor as a
Program preview. The preview shows Confirmed, Updating, Unconfirmed or Out of
date by comparing the program page's applied stage key with the stage this
desktop sent. Share one fit rule (people cover, screens contain) and stage key
with the web through mirrored vectors. Send the selected screen to guests. Add
the opt-in guest graphics lane (D4). It is off per room. When on, guests get
only the stream's landscape avatar and bubble, a clear when it is turned off,
and their own confirmations, which never count as egress output. Give agents an
allowlisted program projection labelled as not encoded output. Extend the
maintained `views` parity case with real 4:3 screen fixtures and guest graphics
checks (not run).

Base: `main` once S16 and its prerequisites are merged there (merge commits, branches kept); the tree sits on S16 `5b340c09c`. Pair with the web S6 PR.
Focused checks only. Live, managed and device acceptance not run. Rust not
compiled. Production qualification false. No issue to close.

## Web PR ready

Title: Plan 249 S6: contain screens, report the applied stage and draw guest graphics

Body: Contain screen tiles on the program page, and report the drawn layout and
the applied stage key in its beacon. Keep them, with the beacon time, in room
state. Show guests the on-stage guest screen the program shows, and play its
audio once, mix-minus, without doubling the soundboard. Add the guest
public-graphics lane (D4). A present guest's own session may advertise only the
stream landscape lane through the cookie route. The page draws the host's public
avatar and bubble with the program's own renderer and confirms the revision. It
clears on opt-out, a new host session, an expired lease or leaving. Share fit
and key vectors with the desktop, and emit the new and changed program modules.

Base: `main` once S16 and its prerequisites are merged there; the tree sits on S16 `78586c99`. Deploy before the desktop. Older
pages stay unconfirmed and never show as applied, and older guest pages simply
get no graphics. Focused checks only. The one existing S16 base failure is
unchanged.

## Integration onto main (coordinator reconciliation, 2026-11-16)

- Desktop `/Users/orcdev/projects/videorc-wt-249-s6-integration`, branch
  `integrate/249-s6-main-reconcile` from `origin/main`
  `dda61b03ef52a97bd74a6796a2a0032d480878e5`; web
  `/Users/orcdev/projects/videorcweb-wt-249-s6-integration`, same branch name,
  from `origin/main` `59fb8ba6c3cd9559523c5d320bad2065f3cdce1d`. Both S16 bases
  (`5b340c09c`, `78586c99`) are ancestors of these mains.
- The S6 delta was taken relative to those S16 bases and applied with a
  three-way apply. The original S6 worktrees are unchanged; byte-for-byte
  backups with SHA-256 are in `/Users/orcdev/249-s6-integration-backup`.
- Web applied cleanly. Desktop had three additive conflicts, resolved by keeping
  both sides: the parity case list and flags (`services`, `replay-ring` from
  main plus S6's `views`), `runBaseline`'s `replayRing`/`views` options and case
  label, and adjacent `describe` blocks in `talk-show-room.test.ts` (S7a's
  microphone producer tests plus S6's stage message tests).
- Changed-line comparison against the original S6 delta: 21 of 23 desktop
  tracked files and all 25 web tracked files are identical; the two desktop
  differences are only those case/flag merges. New files are unchanged copies.
- Merged S7a, S18, S20, S21a and emote changes are untouched. Uncommitted S5
  is not absorbed; its seams (`#bind` order, Program preview row order) remain.
- Rechecked on the integrated trees: desktop TS7 node/web, 12 Vitest files
  (298 tests), 43 `cloud-parity-*` Node tests, Prettier, Oxlint (one existing
  `use-studio.tsx` warning), `cargo fmt --check --all`, em-dash and text gates;
  web `tsc --noEmit`, emitter `--check` (up to date), 12 focused test files
  (163 of 164; the one failure, "end: no feed never ends a talk show...", also
  fails on clean web `origin/main`), scoped ESLint (0 errors) and Prettier;
  `cloud-parity-views.json` mirrors are byte-identical. Shadscan final: desktop
  27, web 47. Rust was not compiled; no smoke, browser, managed or build gate
  ran.
