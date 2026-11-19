# Plan 249 S24: durable presentation and safe controller handoff

Status: implemented at source level on current main, **not qualified**.
Every prerequisite S24 depends on is merged; no S24 source gap is left.

Only lightweight checks ran. Smoke, real-page, device and heavy suites,
builds and Rust compilation are deferred by the owner; the Rust here has
never been compiled. No real credential, provider message, broadcast or paid
call was used.

## Trees and bases

S24 is one change on top of main in each repo, with no merge commit of its
own: every prerequisite is already on main.

- Desktop: `/Users/orcdev/projects/videorc-wt-249-s24-publish`, branch
  `publish/249-s24-on-main` (local, unpublished), at main `4ff715681`.
  - S24 is staged (26 paths). It merges cleanly with open repair PR #1457
    (`fix/main-after-249-merge-batch`, `1f372525d`), which touches three of
    the same Rust files.
- Web: `/Users/orcdev/projects/videorcweb-wt-249-s24-publish`, branch
  `publish/249-s24-on-main`, at main `ab811051`. S24 is staged (19 paths).
- `node_modules` in both trees is an untracked symlink: never stage it.
- Earlier trees are kept as backups and are **not** publication paths:
  - the completion trees (`*-wt-249-s24-completion`), whose staged S15 merge
    sits on a local S5+S9 integration merge (`ec39d7fe0` / `f99b700e`) that
    main replaced with its own;
  - the first S24 trees (`*-wt-249-s24`).
- Backups (binary patches, indices, tarballs) are in
  `~/cloud-parity-scratch/s24/backup-*`.

## Prerequisites

| Slice       | State                                                           | What S24 uses                                                                                                                            |
| ----------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| S16         | On main                                                         | Ending refusal, "a takeover is never an end", the per-show lease, End never 503                                                          |
| S18         | On main (desktop)                                               | Chat ownership follows the show on resume; old readers stop                                                                              |
| S20         | On main (web)                                                   | Its own tables; S24 adds migration 0041 only (main ends at 0040; S22 takes 0042)                                                         |
| S4          | On main                                                         | Avatar snapshot and receipts; the publisher S24 extends                                                                                  |
| S5          | On main (desktop #1451, web #133)                               | Atlas meta kept with the avatar layer (validated both sides); motion, reactions and talk never kept                                      |
| S6 / S9     | On main (desktop #1452 / #1454, web #134 / #136)                | The static seam: `RoomGraphicsPublisher` accepted callback, kept banners (`opacity × fade.to`, S9 ids and bounds), banner restore        |
| S7b         | On main (desktop #1448)                                         | `microphoneChoice`; `setMicrophoneSelection`/`setCameraSelection` for the explicit enable without a rejoin                               |
| S15         | On main (desktop #1456, web #138)                               | Captions are cleared like chat (`desktop-live-source`); its admission/send gate checks controller ownership; a watcher retires listening |
| S21a / S21c | On main (desktop #1449 / #1450, web #131 / #132)                | Archive reads are never fenced; only control routes are. The recording route keeps S21a's `replay-blocked` answer inside the fence       |
| S22         | Unpublished (G1wkh)                                             | Its `controllerCommand` seam takes `withControllerCommand` once S24 is published; ISO is never in `needsEnable`                          |
| Web PR #115 | Open, not merged (`origin/plan-243-continue-on-another-device`) | Read only. Its `on-air` `go` and `hand-off` must take and release the controller through `applyControllerIntent` once it lands           |

## Behaviour

### Controller (web)

- There is one row per show (`cloud_show_controllers`).
- `controller_epoch` only grows. Each takeover moves it by one in a
  compare-and-set.
- The lease is 45 s, and the holder renews it every 15 s.
- `claim` never takes a live lease. `takeover` (the explicit "continue here")
  always moves the epoch.
- An ending or ended show refuses claims; `release` is always allowed.

### Stale and headerless commands (web)

A show that adopted epoch ownership (it has a controller row) takes commands
only with its current epoch, sent in `videorc-controller-epoch`:

- A stale or unreadable epoch gets 409 `cloud-controller-stale`.
- A **missing header** gets 409 `cloud-controller-required`. Leaving the
  header out is never authority, so a desktop from before S24 cannot change
  or end a successor's show.
- This covers destinations, hold image, stage, recording, legs end and End.
  The S24 routes check the epoch in their own compare-and-set.
- A show nobody ever claimed keeps the behaviour from before S24. That is
  decided from server state, never from the header.
- The web Live page's End sends `videorc-control: account-end`. It is the
  account owner's own stop (S16: nobody is ever stuck live), and only End
  accepts it.

### Raced takeover (web)

- `withControllerCommand` registers each command on the controller row in
  the same statement that checks its epoch (`commands_in_flight`, bounded by
  `commands_until`, 65 s).
- A takeover's compare-and-set also needs no live command of the old epoch,
  and is answered 409 `cloud-controller-busy` otherwise. The desktop's
  Resume waits up to ten 1 s steps.
- So a command either finishes before the epoch moves, or it is refused. It
  is never applied after a takeover.
- Tests cover every command class: the takeover landing between the read and
  the registration, a busy takeover, and expiry.

### Desktop authority

- Every request about the held show carries the epoch, added centrally in
  `cloud_send`.
- The claim is **awaited**, so no command goes out headerless after the show
  adopted ownership:
  - room open (plain claim);
  - Go Live (plain claim);
  - solo Go Live (plain claim, after the show exists);
  - room Resume and **solo Resume** (explicit takeover, before anything is
    sent).
  - the Studio's own resume after a backend restart sends the same room
    Resume, and only for a show whose kept epoch was renewed (see "Back in
    the room after a backend restart").
- A refused renewal, or any fenced request answered as stale, marks the show
  lost:
  - `cloud_controller::Ownership::Lost` is announced on a watch
    (`ownership()` / `ownership_now()`), and `CloudStatus.controller.lost` is
    set.
  - The process keeps its stale epoch, so the web keeps refusing it.
  - Nothing more is renewed, kept or desired-reported.
  - S15 (captions) and S8 (system audio) consume this watch.

### Kept presentation (D9)

- After a program page applied a view, the desktop sends that exact view.
  - The receipt must match, for _that page_, the lane, the local session
    id, the revision it was sent, and an envelope that has not expired.
  - `#sent` holds the exact sanitized envelope sent. Only the applied
    acknowledgement counts: never an upload or the local preview.
  - With S5, the atlas variant goes to animation pages and the static
    variant to the rest. Each view is kept as its own page got it.
  - Acceptance runs before any visibility check, so a clear always
    persists: an empty view, Hide, an output switched off, or a view with
    nothing retained. A takeover never brings back what was taken off.
  - Client side, each output view (output, orientation, session id) reports
    only a revision higher than the last one reported. A late
    acknowledgement from another page of the same view changes nothing.
- What the web keeps:
  - The avatar layer, with its validated atlas meta.
  - Banners on screen, at S9's `opacity × fade.to`, with S9's layer ids.
- What it drops: bubbles, highlight cards, hiding banners, and any layer
  with an expiry.
- What it clears: the chat box (S9) and a live caption (S15), with reason
  `desktop-live-source`. It also keeps clears.
- Bounds: seven static layers with S15's caption, but at most four
  banners, one chat and one caption.
- Pixels are stored once per show by verified SHA-256, kept 24 h, and
  deleted at show end.
- Ordering is by epoch, then by the controller's acceptance `sequence`.
  - The backend stamps `sequence` in the order the acknowledgements reach
    it, before the writes run concurrently.
  - So a write that finishes late, or comes from an older LiveKit session,
    never replaces a newer view.
  - Without a sequence (an older desktop), the order is session, then
    revision.

### Static graphics (S9) across a takeover

- `RoomGraphicsPublisher` reports each static view a page applied, with the
  same rules as the avatar.
  - It runs before the visibility check, so an applied empty view, Hide, an
    output switched off, or chat only replaces what the cloud had.
  - `#sent` holds the exact envelope; acceptance requires a matching session
    id, lane and revision, and an envelope that has not expired.
  - Revisions only increase per view.
- The hook forwards each one once per change (`topic: 'static'`).
- What comes back: only banners, at rest (no fade, no expiry), at most four
  per orientation, for the outputs whose banner flag is on.
- When it comes back: this computer's native banner state is the source of
  truth, and the room graphics toggle starts off.
  - So kept banners return once the streamer turns graphics on, and fill
    only an orientation where this computer shows no banner of its own.
  - They stop as soon as its own banner list changes (`banners.changed`).
  - Chat, captions and cards never come back: they are live desktop sources
    or one-shots.

### Host-loss continuity: the supported policy

The supported policy is restore by the successor controller. Nothing is
preserved through the gap.

- While no controller publishes, a program page keeps what it applied only
  for its transport lease (S4/S9: 30 s), then clears it. The gap is visible.
- What was kept comes back only through the next controller, re-sent under
  its own envelope. It is on air again only once that controller's own
  receipts say so (`applied: false` until then).
- The restore answer states this policy in `continuity`.
- The acceptance phase measures the clear before anyone resumes
  (`report.handoff.hostLoss.programClearedAfterMs`,
  `preservedThroughGap: false`), so the 30 s clear is never counted as a
  preserved layer.
- Output flags carry over: an output the controller turned the avatar off on
  stays off on restore.
- TTL and clears are kept, and one-shots stay expired.
- Program pages never read storage. A durable program-side recovery would
  need its own authorization and real-page qualification; it is not built.

### Explicit re-enable after a takeover

- Camera and microphone are withheld (S7b's `microphoneChoice` and the
  camera name are masked to null) until the streamer presses "Turn on".
- "Turn on" opens them through S7b's live selection, with no rejoin.
- Not after a takeover from this same computer (`takenOverFrom:
this-device`: a backend restart or a relaunch, then Resume). The room
  opens the camera and microphone as this computer had them, and nothing
  waits for "Turn on" (2026-11-19: the hold kept the host's microphone out
  of a live room after a backend restart).
- A Sources pick meanwhile is refused (`sourcesHeld`). Turning things off
  stays allowed.
- An epoch change still rejoins, for the same show too.
- Sounds start off per client (S3).
- System audio (S8) and HTML (S11) are named in `needsEnable`.
- Nothing ends a provider broadcast. Private Sidekick context and local
  files never move.

### Back in the room after a backend restart (rule change, 2026-11-19)

S24's rule was "Resume takes the show over explicitly": after any restart,
the room and its devices waited for the streamer's Resume. The owner changed
it on 2026-11-19, after the backend restarted in the middle of a live talk
show (14:21:19Z) and the host stayed out of their own room until they
pressed Resume.

- When the backend restarts while this computer's room is open, the Studio
  sends `cloud.room.resume` itself. Nobody presses Resume or Continue here.
- It does so only when all of this holds (`autoRejoinDecision` in
  `lib/talk-show-auto-rejoin.ts`, pure and tested):
  - this renderer had the room open (joined or joining) when its backend
    connection went away, and the room was not closed, ended or taken over
    under the backend that held it;
  - the new backend reports the same talk show as resumable;
  - the new backend holds the show's controller epoch, not lost. That is
    the kept epoch videorc.com renewed for this computer (#1565), so nobody
    took the show over;
  - no other device is on air, and the show is not waiting for a device
    after a hand-off.
- A show another device took over is never resumed this way. The kept epoch
  is refused there, no controller is reported, and the notice keeps its
  explicit Continue here, which is still the only takeover.
- Once per backend. The Studio asks the new backend for its status for up to
  30 s (the launch check and the renewal), then resumes. A failed resume is
  tried again after 2 s and after 5 s, with the rule checked again each
  time; then it gives up and the Resume notice is the streamer's.
- Camera and microphone come back as they were, the same as a Resume from
  this computer: nothing waits for "Turn on". A muted microphone stays
  muted and a camera that was off stays off (the join reads the Studio's
  own `microphoneMuted` and `cameraOff`, which a backend restart does not
  touch).
- What the host sees: the Resume notice reads "Reconnecting to your show…"
  with its button waiting ("Reconnecting…"; End livestream stays), and one
  entry behind the bell, "Reconnecting to your show", which becomes "Back in
  your show" once the room is connected, or "Couldn't reconnect to your
  show. Press Resume in the Studio to go back in."
- A relaunch of the whole app is unchanged: a new Studio had no room open,
  so its notice waits for Resume.
- The join now also waits for the new backend's first status. The Studio
  keeps the old backend's status until then, and joining on it asked the new
  backend for a room token it could not give.
- Known limit: the rule is decided in the renderer from the backend's
  status. A takeover by another device in the instant between that status
  and the resume is not seen, and the resume would take the show back.

## Acceptance case (maintained, not executed)

Run `VIDEORC_PARITY_WEB_ROOT=… node scripts/smoke-cloud-parity-app.mjs --case handoff`.
It runs these steps:

1. The web S24 tests and the Rust `cloud_controller::tests`.
2. The real-page avatar case.
3. `exerciseHandoff`, which:
   - checks epoch 1 and the kept avatar for both outputs, with no one-shot;
   - kills the exact owned backend PID;
   - **observes the program clearing during the gap**;
   - resumes on a fresh fixture computer, and checks epoch 2, the device
     notice, and stale **and headerless** stage, legs end and End (409, with
     the show never ended);
   - checks the restored avatar, that no bubble appears for 6 s, and that a
     view is kept under epoch 2.

## Remaining before PR readiness

- **Publication**: one commit per repo on current main (see "Trees and
  bases"). Desktop main does not build until repair PR #1457 lands, so the
  Rust checks below run on main with #1457.
- **S15 seam, done here (S24 published second).**
  - `spawn_cloud_ownership_watch` (main.rs) awaits
    `captions::cloud_host::ownership_lost` when a held show is lost or
    forgotten.
  - `cloud_host::show_owned` checks `cloud_controller::ownership_allows`
    synchronously: held allows, lost refuses, never-held keeps S15's policy,
    and a loss after holding stays latched.
- **S22.** Once S24 is published, S22 wires its ISO route seam to
  `withControllerCommand`. Migrations are 0041 (S24) and 0042 (S22).
- **Web PR #115.** When it lands, its `on-air` `go` calls
  `applyControllerIntent` with a takeover, and `hand-off` calls it with a
  release.
  - Both run inside the show lease, and keep S16's `showEnding` refusal.
- **S8.** It reads `CloudStatus.controller` (`controllerEpoch`,
  `takenOverFrom`, `lost`) and reports `system` through
  `cloud.controller.desired`.
- **Rust is uncompiled.** Before merging: `cargo test -p videorc-backend
cloud_controller`, and `clippy -D warnings`, on main with #1457.

## Remaining runtime limits (not waived)

- Program pages show nothing kept during host loss (the supported policy
  above).
- A command killed by the platform holds a takeover off for at most
  `commands_until` (65 s).
- A legacy command racing the very first claim of a never-claimed show can
  land just after that claim.
- Kept banners need the graphics toggle on, and give way to this
  computer's own banners. The atlas restores at rest; S5 motion starts only
  from the new computer's own animator.
