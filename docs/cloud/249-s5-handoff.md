# Plan 249 S5 handoff: animated avatar and Sidekick presentation

Slice-specific handoff (the central execution ledger belongs to S20). Uncommitted;
the coordinator publishes.

| Repository | Worktree                                                  | Branch                            | Base (`main`) |
| ---------- | --------------------------------------------------------- | --------------------------------- | ------------- |
| Desktop    | `/Users/orcdev/projects/videorc-wt-249-s5-integration`    | `integrate/249-s5-main-reconcile` | `dda61b03e`   |
| Web        | `/Users/orcdev/projects/videorcweb-wt-249-s5-integration` | `integrate/249-s5-main-reconcile` | `59fb8ba6`    |

S5 was built on the S4 tips (desktop `6a142e936`, web `9f708259`) and then
reconciled onto `main` after S0 to S4, S7a, S16, S18, S20 and S21a merged. The
frozen S4-based trees (`videorc-wt-249-s5`, `videorcweb-wt-249-s5`, branch
`feat/249-s5-cloud-parity`) are kept unchanged, with binary patch backups in
`~/s5-scratch/backup-pre-main/`. Only two desktop files conflicted, both in the
parity runner: `scripts/lib/cloud-parity-baseline.mjs` and
`scripts/smoke-cloud-parity-app.mjs` keep S21a's `replay-ring` case and add
S5's `avatar-animation` case beside it. Everything else applied cleanly; S7a's
PCM microphone, S16's lifecycle and S20's Library hunks in the same files are
untouched. The web side applied cleanly and the emitter reports the bundles
up to date. `docs/cloud/249-s4-contract.md` stays canonical; S5 only adds the
extensions agreed with the S4 owner. No forge action was performed.

## What S5 adds

- **The compositor's animator, in TypeScript.** `shared/buddy-animator.ts`
  ports `buddy_animator.rs` rule for rule (gaze, card looks, think gaze, talk
  cadence, blink, sleep and the surprised wake, reaction queue of two with 6 s
  expiry, hold of `max(1.1 s, envelope)`, motion-only hop, breathing, persona
  settings) with the same SplitMix64. `buddy-animator.test.ts` replays the Rust
  module's pinned 210 s scripted session cell by cell and its five transform
  snapshots: they match exactly. `buddy-motion.ts` gains `saveState/loadState`.
- **Cloud driver** `shared/cloud-avatar-motion.ts`: a fixed 60 Hz show clock;
  both outputs (`h` leads, as the primary leg) stepped per tick; stamped,
  id-numbered public events; keyframes every 2 s with the events not yet
  applied. `MotionReceiver`: owner SID and epoch fenced, rate limited
  (20 msg/s), 10 s lease, 200 ms playout delay, idempotent ids, late join from
  a keyframe, rewind-and-resimulate for a late event (bounded to 6 s of ticks),
  never a replay. `MotionProducer` stamps events strictly after the simulated
  time. Strict validation: unknown fields refuse an event (no text rides along),
  every keyframe field is bounded.
- **Atlas meta** `shared/cloud-avatar-atlas-meta.ts` (dependency-free): at most
  64 cells, square cells of at least 32 px inside the PNG, a gaze neutral,
  known talk frames. S4's limits are unchanged (1024 x 1024, 256 KiB base64,
  512 KiB snapshot); the renderer packs at <= 256 px cells, steps down to 64 px,
  else keeps the still avatar.
- **Backend public projection.** `buddy_animator::public_event` and
  `BuddySpriteSlot` emit `cohost.pet.animator` (`{avatarState?, event?}`) from
  the one funnel every animator event passes: moods, lengths, times and the
  reaction chain already resolved from trigger + persona. Never bubble text,
  prompts or the persona table. Renderer contract: `buddy-animator-public.ts`.
- **S4 extensions (agreed):** `AvatarCapability.animation?: 1`; an `avatar`
  layer may carry `atlas` meta validated against its PNG; `AvatarContent.animated`
  goes only to `animation: 1` receipts (others keep S4's static layers);
  `RoomAvatarPublisher.motionTargets()` / `motionCoverage()`;
  `createAvatarView(root, now, motion?)` paints an atlas canvas each `step()`
  from any `AvatarMotionSource` (`advance`, `draw(orientation, atlasHash)`,
  `sim.tick`; `MotionReceiver` satisfies it), neutral at rest without motion
  or on an atlas hash mismatch. S4's receiver, lease, clear-outranks-decode
  and two-frame paint acknowledgement are unchanged.
- **Room wiring.** `TalkShowRoomClient.setAvatarMotion/avatarMotionEvent`
  (timer only while an animated avatar is set; producer created once the host
  SID exists, recreated on a new SID; motion sent with `publishData` on
  `videorc.presentation.avatar-motion.v1` to `motionTargets()` only).
  `use-talk-show-room` builds the atlas once per worn pack (cache) and forwards
  `cohost.pet.animator`.
- **Look-at-card from accepted cards only.** The avatar looks at the card
  each output accepted: `cloud.room.overlay` slot `card`, per orientation,
  recorded when the relay took its bytes (`sent`), dropped on its clear, a
  failed or superseded send, or its time-to-live. An output with no accepted
  card has no card input (`null`), so the avatar never looks at a card that
  output does not show. `overlayLayout.highlight` is no longer used.
  `avatarMotionProbe().cards` reports which outputs have one.
- **Desktop Program preview animates.** S4's preview snapshot carries the
  animated `h` layers when an atlas exists, and `ProgramAvatar` (Show stage)
  draws them from the producer's own simulation
  (`TalkShowRoomClient.avatarMotionSource`, via `TalkShowContextValue`), the
  poses the outputs replay 200 ms later. No stream running or another atlas:
  the neutral cell at rest. S6 (G9zgb) was told; S6 keeps monitor geometry
  and labels.
- **Truthful animation status.** `RoomAvatarStatus.animation`
  (`{ state: 'animated' | 'still', reason }`, absent for a still avatar) shows
  under the Program preview (`show-stage-avatar-animation`): an atlas the
  cloud refuses ("The avatar shows still on cloud outputs: it is too detailed
  to animate there." / "...too many frames..."), any other atlas failure
  ("Couldn't animate the avatar on cloud outputs. It shows still."), a motion
  delivery problem, or outputs from before animation ("Some outputs show the
  avatar still. Reload them to animate it."). The console keeps the detail.
- **Web program.** Mirrors (reformatted only): `buddy-animator.ts`,
  `cloud-avatar-motion.ts`, `cloud-avatar-atlas-meta.ts`, `cloud-avatar.ts`,
  `cloud-avatar-view.ts`; `buddy-motion.ts` is the program's copy of
  `lib/buddy/motion.ts` plus save/restore. `stage.ts` advertises
  `animation: 1` and feeds a `MotionReceiver`; `source.ts` accepts the motion
  topic from `host:<show>` only, size bounded before parsing; the relay keeps
  `animation` when it strips a stale ack. Bundles regenerated by the emitter.
- **Sidekick privacy and spend.** Inference stays desktop-only. Bubble-only
  spend stays behind S4's `buddy_visible` (applied cloud output); chat delivery
  is unchanged. No TTS, no guest speech listening.

## Verification run (focused, lightweight, on `main`)

- Desktop vitest over `src/shared`, `src/renderer/src/hooks`, the room,
  publisher, motion, PCM and Show stage tests and the renderer guards: 91
  files, 1169 passed, 1 skipped (the fixture writer), 2 failed. Both failures
  are in files S5 does not touch and that equal `main` byte for byte:
  `renderer-copy-guards` flags `src/lib/cloud-provider-lifecycle.ts:29,33`
  (S16) and `renderer-style-guards` flags `src/lib/room-screen-privacy.ts:99`
  (S2). S5's own tests: `cloud-avatar-view-motion.test.ts` (happy-dom: the view
  paints a source's pose, rests on another hash), accepted-card, status and
  preview-source tests in `talk-show-room.test.ts`, coverage and animated
  preview in `room-avatar-publisher-animation.test.ts`, the status line in
  `show-stage.test.ts`, refusal copy in `room-avatar-motion.test.ts`, the
  animator replay in `buddy-animator.test.ts`.
- Desktop `tsc` (web and node projects): clean. `oxlint` on the touched files:
  one warning at `use-studio.tsx:19880`, the same warning `main` has. Prettier
  and the em-dash gate: clean.
- `rustfmt --edition 2024 --check` on `buddy_animator.rs`,
  `buddy_animator/tests.rs`, `buddy_sprite.rs`: clean. **Cargo was not run**:
  the Rust edits and the new `public_event` test are uncompiled. `main` did not
  change these files since S4.
- Script tests (`node --test scripts/lib/*.test.mjs scripts/live-lab/lib/*.test.mjs`):
  3363 of 3366 pass, 2 skipped, 1 failed:
  `windows-local-gates` refuses the worktree's symlinked `node_modules`
  ("repository dependency root must be one regular, non-symlink directory"),
  an environment check unrelated to S5. The parity tests
  (`cloud-parity-*.test.mjs`, `buddy-name-docs-guard`): 39 of 39.
  `parseParityArgs` accepts `--case avatar-animation` against `main`'s plan.
  `node --check` on the new and resolved runner modules.
- Web: scoped `tsc` with the web's strict config over every touched module:
  clean. Focused tests (`cloud-avatar-motion`, `cloud-avatar`,
  `cloud-program-bundle`, `-stage`, `-source`, `-ring`, `cloud-room-media-v2`,
  `cloud-media-seam`): 86 of 88 pass. The two failures ("the stage's colours
  are the runner's luma values" and "a stored node show keeps node resume,
  lost, usage, reaper and End after switching the env to livekit") fail
  identically on a clean `59fb8ba6` checkout. `emit.ts --check`: up to date.
  ESLint and Prettier: clean.
- Mirror check: each web mirror (`buddy-animator`, `cloud-avatar-motion`,
  `cloud-avatar-atlas-meta`, `cloud-avatar`, `cloud-avatar-view`) equals the
  desktop source run through the web's Prettier;
  `tests/fixtures/buddy-animator-events.json` is a byte copy of
  `protocol-fixtures/buddy-animator-events.json`. `main` changed none of the
  mirrored sources since S4.
- Shadscan (`pnpm dlx @shadscan/cli@next --json`, desktop from `apps/desktop`):
  desktop 27 (54 findings, the same set as the S4-based run), web 47 (59
  findings). Outputs in `~/s5-scratch/int-{desktop,web}-shadscan.json`.

## Merge notes

- S9 relay: take S9's `room-media-relay.ts` block (destructures only
  `applied`) and drop S5's explicit `animation` line; keep both additions in
  `cloud-avatar.ts` (both repos), then rerun the web emitter.
- S6: adjacent lines in `talk-show-room.ts` `#bind` (keep S6's
  `#avatar.guests(...)` after S5's `#publishAvatar()`) and separate hunks in
  `show-stage.tsx`/`show-stage.test.ts`: status line, then S5's animation
  line, then S6's guest row. Guests get no motion until the guest page
  advertises `animation: 1`; then widen `motionCoverage()`'s `EG_` filter to
  S6's lane rule.
- S7b (PR #1448) and S21a follow-ups (PR #1449, web #131) were not absorbed;
  S5 does not need them.

## Deferred gates (owner deferred until after merges on main)

D and N in full, B (`cargo fmt`, `cargo test -p videorc-backend`, clippy), W in
full, WB, C, R, `pnpm smoke:buddy-pet`, `smoke:buddy-act`,
`smoke:buddy-commands`, `pnpm smoke:cloud-parity -- --case avatar-animation`
(new: compares program, recording and the desktop Program preview poses with
the desktop producer at shared ticks, one wave per press, talk cadence, late
join without replay, hide) and
`--case avatar` (now counts canvas or img). Managed, device and production
qualification: not run.
