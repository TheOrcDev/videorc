# Shared protocol fixtures

`high-risk-contracts.json` is the platform-neutral wire-contract fixture shared by
the Rust backend and TypeScript desktop tests. It covers the protocol shapes most
likely to cause silent cross-process failures: native preview placement, scene and
layout data, recording/compositor status nullability, desktop account authorization
(including its main-owned retry deadline),
Library comment pagination/deletion (including the terminal page shape), and the
account plan blocks (`accountPlans`, plan 185 T4): a Max `/api/ai/capabilities`
answer with its optional `plan` and `cloud` blocks, the Premium `cloud` block
(also the `GET /api/cloud/allowance` answer), and the desktop's own
`EntitlementsSnapshot` with and without `plan`. `plan` is never a tier value and
an absent option is an absent key, never `null`.

The JSON is the authoritative example. A wire-shape change must update the fixture
and keep both test suites green:

- Rust: `cargo test -p videorc-backend shared_high_risk_contract_fixture`
- TypeScript: `pnpm --filter @videorc/desktop test -- protocol-contract-fixtures.test.ts`

Fixture paths are relative opaque strings and do not assume Windows or POSIX path
syntax. Never put machine-specific paths, tokens, recordings, or account data here.

## `buddy-motion.json`

The avatar's motion envelopes (plan 168, D6): for every page-pet reaction pose,
the default pose, a raw nudge, a gaze turn, a talk-bob train and breathing, the
transform every 1/60 s for 2 s at Motion 0.45 and 1.0, drawn at 180 px and
360 px, plus the GSAP easing formulas at 101 points. It is generated FROM the
Rust model; both models must reproduce it within `tolerance` (1e-4):

- Regenerate after a deliberate motion change:
  `cargo test -p videorc-backend buddy_motion::tests::write_shared_fixture -- --ignored`
- Rust: `cargo test -p videorc-backend buddy_motion`
- TypeScript: `pnpm --filter @videorc/desktop test -- buddy-motion.test.ts`

## `buddy-animator-events.json`

The avatar's cloud animation (plan 249 S5): a seeded scripted show (reactions,
the card on both outputs, talk, think, laugh, a full queue, a motion-only hop,
a persona switch, sleep and the surprised wake, an expired reaction) as
stamped public events, and the cell and transform on both 1080p outputs every
15 ticks of the 60 Hz show clock. It is generated FROM the TypeScript cloud
driver (`apps/desktop/src/shared/cloud-avatar-motion.ts`), whose animator
(`buddy-animator.ts`) replays the Rust animator's pinned scripted session cell
by cell. The web program keeps a byte copy in `tests/fixtures/`:

- Regenerate after a deliberate rule change, then run Prettier on it:
  `WRITE_BUDDY_ANIMATOR_VECTORS=1 pnpm --filter @videorc/desktop test -- cloud-avatar-motion.test.ts`
- TypeScript: `pnpm --filter @videorc/desktop test -- buddy-animator.test.ts cloud-avatar-motion.test.ts`
- Web: `node --import tsx --test tests/cloud-avatar-motion.test.ts`

## `buddy-official-catalog.json`

Videorc's official avatars (plan 170, D10 and D11), edited by hand. The
desktop catalog (`apps/desktop/src/shared/buddy-library.ts`), the backend table
(`crates/videorc-backend/src/cohost_library.rs`) and the web catalog
(videorc-web `lib/buddy/official.ts`) must equal it:

- Rust: `cargo test -p videorc-backend buddy_official_catalog`
- TypeScript: `pnpm --filter @videorc/desktop test -- buddy-library.test.ts`

The library RPC shapes (`cohost.library.*`) ride `high-risk-contracts.json`
under `buddyLibrary`, with the rest of the shared wire fixtures.

## `metrics-journal-v1.ndjson`

Schema v1 of the metrics journal (plan 166 S1, plan 178 U1): the NDJSON lines
the backend appends to `<userData>/logs/metrics/<yyyy-mm-dd>.ndjson` (UTC day)
while the journal is on (`VIDEORC_METRICS_JOURNAL=1` or the
`diagnostics.metricsJournal` setting). Three lines: an idle `sample`, a
`health` line and a live `sample` with three legs. It is generated FROM the
Rust builder; the test also asserts no line carries an `rtmp(s)://` URL or a
stream-key-shaped value. Every field is present on every line; nullable fields
are an explicit `null`.

- Regenerate after a deliberate schema change (bump `schemaVersion`):
  `cargo test -p videorc-backend metrics_journal::tests::write_shared_fixture -- --ignored`
- Rust: `cargo test -p videorc-backend metrics_journal`

## `preview-program.json`

The program (plan 205): whether an item with a given pair of output switches
is in the picture the Preview shows, for every session shape. It is edited by
hand; both functions must reproduce every case:

- Rust: `cargo test -p videorc-backend preview_program`
- TypeScript: `pnpm --filter @videorc/desktop test -- overlay-layout.test.ts`

## `preview-cpu-ring.json`

Plan 260 S1.7 (from plan 220 S4.1d): the CPU preview ring's wire shapes,
`preview.cpu.open`'s answer and `preview.cpu.status` (`PreviewCpuRingStatus`,
`PreviewCpuRing` in `crates/videorc-protocol`). Absent fields are omitted,
never `null`; the handle is a memfd path on Linux, a file-mapping name on
Windows and a POSIX shared memory name on macOS (`handleKind`: `memfd-path`,
`file-mapping`, `posix-shm`).

- Rust: `cargo test -p videorc-backend --bin videorc-backend -- preview_cpu_ring`
- Reader: `crates/videorc-preview/src/cpu_frames.rs`; Electron has no consumer.

## `screen-privacy.json`

Hide screen's wire shapes (plan 210 S7): the `ScreenPrivacy` state as
`screen.privacy.get` returns it and `screen.privacy.changed` carries it
(visible, hidden by you, hidden by the password-manager list, unavailable on a
legacy FFmpeg session), the `screen.hide` params, and shapes the renderer must
reject (a `null` field, an unknown reason). Absent fields are omitted, never
`null`; the Rust test serializes the backend types and compares them with the
JSON field for field.

- Rust: `cargo test -p videorc-backend screen_privacy_fixture`
- TypeScript: `pnpm --filter @videorc/desktop test -- backend-rpc-contract.test.ts`

## `virtual-camera.json`

Videorc Camera's wire shapes (plan 214 A4): the `VirtualCameraStatus` as
`virtualCamera.status` and `virtualCamera.set` return it and
`virtualCamera.changed` carries it (off, unavailable without a sink, needs
approval, needs setup, ready, streaming with and without a viewer count),
the `virtualCamera.set` params, the `virtualCamera.platform.report` params
main sends (with and without a message), and shapes the renderer must reject
(a `null` field, an unknown state, a missing flag). Absent fields are
omitted, never `null`; the Rust test serializes the backend types and
compares them with the JSON field for field.

- Rust: `cargo test -p videorc-backend virtual_camera_fixture`
- TypeScript: `pnpm --filter @videorc/desktop test -- backend-rpc-contract.test.ts`

## `room-latency.json`

How a managed talk show measures its own delay (plan 253,
`docs/cloud/253-latency-contract.md`), edited by hand: the `net` blocks the
parser accepts and refuses, the relay's envelope, the sampler's arithmetic on
canned WebRTC stats reports (deltas over a window, never session totals), and
the room cases: held blocks in, each guest's conversation delay and the
program delay out, with a missing part, `partial` and a stale report. The
desktop model (`apps/desktop/src/shared/room-latency.ts`) and the web's copy
(videorc-web `lib/cloud/program/room-latency.ts`) must both pass it. The web
keeps a byte copy in `tests/fixtures/`:

- TypeScript: `pnpm --filter @videorc/desktop test -- room-latency.test.ts`
- Web: `node --import tsx --test tests/room-latency.test.ts`

## `room-program-camera.json`

Plan 249 S23: the room's Program preview as Videorc Camera's picture. The
40-byte `VRPC` frame header main writes before each 1280x720 RGBA frame (one
exact vector and the headers the parser must refuse), the I420 values the
backend's conversion must produce (the CPU compositor's BT.709 video-range
helpers), the status `source` names, and the device labels that are Videorc
Camera (never the room's camera).

- Rust: `cargo test -p videorc-backend room_program_camera`
- TypeScript: `pnpm --filter @videorc/desktop test -- room-program-camera.test.ts`

## `community.json`

Know your viewers across platforms (plan 225, A6): a chat row with and
without `arrival`, the smallest arrival, the `cohostSettings.community`
block, the summary, a full person and the zero-count person an unknown
account gets, a list page, the `cohost.state` lane (`welcomeBack`,
`linkMade`), and shapes the renderer must refuse (a `null` optional field, an
unknown milestone kind or status, a link with one name). Absent fields are
omitted, never `null`; both sides round-trip every shape field for field.

- Rust: `cargo test -p videorc-backend shared_community_fixture`
- TypeScript: `pnpm --filter @videorc/desktop test -- backend-rpc-contract.test.ts`

## `guest-consent-lines.json`

Plan 224 D13 (review L2): the consent line a guest reads before "Ask to join",
for a set of saved platforms, edited by hand. The guest page (videorc-web
`lib/cloud/guest-consent.ts` `consentLine`) and the Guests tab
(`apps/desktop/src/renderer/src/lib/guests-view.ts` `guestConsentLine`) must
both say every case word for word; videorc-web keeps a byte-identical copy at
`tests/fixtures/guest-consent-lines.json`.

- TypeScript: `pnpm --filter @videorc/desktop test -- guests-view.test.ts`
- Web: `node --test tests/guest-consent-lines.test.ts` in videorc-web

## `html-overlay-frame.json`

The header of one HTML overlay frame record (plan 232 "Wire"): what Electron
main writes on its upload to the backend (`POST /html-overlays/frames`) before
each frame's premultiplied BGRA pixels. Edited by hand. Main's encoder and the
backend's parser must both reproduce every case byte for byte:

- Rust: `cargo test -p videorc-backend html_overlay`
- TypeScript: `pnpm --filter @videorc/desktop test -- html-overlay-frames.test.ts`

The overlay's RPC and event shapes (`htmlOverlays.*`, a banner with
`kind: "html"`) ride `high-risk-contracts.json` under `htmlOverlay`.

## `scene-pictures.json`

Scene stills (plan 231 S5): ordered app/window/display targets, JPEG bytes,
per-target unavailability, Hide screen refusal, and unsupported platforms.
Optional flags are omitted, never null. Both languages read this fixture:

- Rust: `cargo test -p videorc-backend scene_pictures`
- TypeScript: `pnpm --filter @videorc/desktop test -- backend-rpc-contract.test.ts`

## `scene-layout-retention.json`

Plan 231 D18's layout request pair: legacy omission and `retainScreen: true`,
shared by preview/live. It prevents retirement only and never requests startup.
`verticalLeg` is plan 231 D4's live-only `verticalLegScreen: true`: a program
that draws no screen while the running vertical leg draws the selected one,
which the commit then needs (started, or switched to, and kept).
Rust: `cargo test -p videorc-backend retain_screen` and `vertical_leg_screen`;
TypeScript:
`pnpm --filter @videorc/desktop exec vitest run src/shared/backend-rpc-contract.test.ts`.

## `camera-background.json`

A camera's background (plan 258 S1, D3/D4): one pick per camera, stored by the
renderer beside the camera look and put on `LayoutSettings.cameraBackground` at
the output boundary (absent while Off). `full` carries every field, `everyMode`
one of each pick, `rejectedEverywhere` the shapes both serde and the strict
contracts refuse, and `rejectedByContract` the bounds only the RPC and IPC
contracts check (the renderer clamps them before they are sent).

- Rust: `cargo test -p videorc-backend camera_background_fixture`
- TypeScript: `pnpm --filter @videorc/desktop test -- camera-background.test.ts`

## `camera-background-status.json`

The camera effect stage on `preview.camera.status` (plan 258 S3):
`cameraBackground` while a blur or a picture is on, absent while Off or a
screen key. `running`, `cover` and `unavailable` are what the backend sends;
`rejectedCameraBackground` the shapes the strict contract refuses (an unknown
state or mode, a missing or negative counter, `null` for an absent field, a
field it does not know).

- Rust: `cargo test -p videorc-backend camera_background_status_fixture`
- TypeScript:
  `pnpm --filter @videorc/desktop exec vitest run src/shared/backend-rpc-contract.test.ts`

## `obs/`

A scrubbed copy of a real OBS Studio setup for OBS import (O1; the backend
reads it since plan 260 S1.5d): `collection.json` (multi-scene,
multi-camera, macOS sources), a profile's `basic.ini` (4K at 24 NTSC) and
`service.json` (its stream key is `fixture-not-a-real-key`). The renderer's
mapping tests and `pnpm smoke:obs-import` use the same files.

- Rust: `cargo test -p videorc-backend obs_import`
- TypeScript: `pnpm --filter @videorc/desktop test -- obs-import-map.test.ts`

## `agent-config-entry.json`

What "Add to …" writes into an agent app's config (plan 209 S22; the backend
writes it since plan 260 S1.5c), and what the Connect dialog shows as the line
to paste: the `videorc` JSON entry per app with its root key, Codex's
`[mcp_servers.videorc]` lines, and the `claude mcp add` arguments. The bridge
path has a space, quotes and backslashes so every escape is pinned. The token
is a placeholder of the right shape, never a real one.

- Rust: `cargo test -p videorc-backend agent_config_entry_fixture`
- TypeScript: `pnpm --filter @videorc/desktop test -- agent-config-entry.test.ts`

## `ui-settings-previous-release-profile.json`

A renderer `localStorage` profile the previous release (0.37.x) wrote, every
key with a value of the shape its writer produces (plan 260 S1.4, from plan
220 S1.4a). The one-time migration copies each string verbatim into the
backend UI settings store (`app_settings` rows under `ui:`, a JSON string per
key); both halves prove the copy arrives intact, once, and never overwrites a
value this release wrote first. Keys with a dynamic tail
(`videorc.sources.more.<id>`, `videorc.buddyWornPack:<id>`) carry one
representative id. No machine paths, tokens or account data.

- Rust: `cargo test -p videorc-backend ui_settings`
- TypeScript: `pnpm --filter @videorc/desktop test -- ui-settings-store.test.ts`
  and `backend-rpc-contract.test.ts`
