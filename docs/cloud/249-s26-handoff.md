# Plan 249 S26 handoff: health and diagnostics represent the program

Status: source implemented on desktop and web, focused TS and web gates run,
**Rust not compiled** (owner standing rule: one Rust build and the smokes run
on main before the release), `--case health` authored and **not run**. Live,
managed, device and production qualification remain `not-run`.

## Stacking

| Repository | Branch                      | Base                                                                                                                                               | Must merge first |
| ---------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Desktop    | `feat/249-s26-cloud-parity` | `main` + S17 [#1460](https://github.com/TheOrcDev/videorc/pull/1460) + S24 [#1461](https://github.com/TheOrcDev/videorc/pull/1461), merged locally | #1460 and #1461  |
| Web        | `feat/249-s26-cloud-parity` | `main` (S17 web #141 and S24 web #142 are merged)                                                                                                  | nothing          |

Deploy order: web first (a consumer of nothing new, it only adds optional
fields), then the desktop. An older desktop ignores `outputHealth` and
`faults`; an older web sends neither, and this desktop then reads Unknown and
raises no new alert. The web also learns the two new push check ids before
any desktop sends them.

## What each layer now says

- **Contributions** (from the room's own listing): the host is not in the
  room, the host's microphone track is missing or muted, the host's camera is
  on stage but the program draws no frame of it, a guest on stage with no
  frames or no microphone.
- **Program pages** (from their beacons, as the web keeps them), per output:
  `reporting`, `stale` (no beacon for 25 s) or `missing`; the page's black,
  frozen and silent counters only while it reports; whether its audio was
  `measured`, `unmeasured` (no working meter) or `unknown`; the stage it last
  applied; and its fault counts (snapshots that failed to draw, streams
  dropped at a bound).
- **Egress** per output: its status and, while running, the S17 effective
  profile (resolution, picture fps, bitrate) and whether it also records.

Health (`components/tabs/cloud-program-health.tsx`, in Health's lazy chunk)
lists the three layers while a room is open, under a note that the program
preview is drawn on this computer and never proves the encoded audio.

## Watchdog

- `no-voice` and `still-there` never open on a cloud room: the room's
  microphone is metered in the renderer only, so the watchdog's voice is
  Unknown (`mic_unmeasured`), never "five minutes of silence".
- `mic-muted` reads the room's own word for the host's muted track; a
  takeover still withdraws it (intentional takeover mute is not dead audio).
- New `program-unreported` (warning, per output, 30 s): a running output's
  page does not report. Clears when it reports again, leaves quietly when the
  output stops. Its numbers are Unknown: no program-silent or picture-black
  is raised from a stale page.
- New `contribution-missing` (per layer, 20 s): `host-room` (critical),
  `host-microphone` (critical; withdrawn under a takeover), `host-camera`
  (warning; a camera switched off is not expected and is never "is back").
- The talk-show checks read the primary page's counters, else the first
  reporting output's: a show whose primary page went quiet keeps eyes on
  another output. Still no A/V skew for a managed output.

## App lifecycle admission

`shared/cloud-room-activity.ts` is the one reading of a room's live activity
(open, this computer on air, no hand-off or takeover; `live` or `recording`).
Main's display-sleep guard, update install, permission restart, relaunch and
account-refresh guards read it through `guardCaptureState`; the backend's
interruption lease refuses `capture-not-idle` while `CloudStatus::room_activity`
is set; the renderer's watchdog surface treats a live room as live (system
notifications, idle reports). The quit/close question is unchanged (live only).

## Not compiled / not run

- Rust: `watchdog/{alerts,checks,mod}.rs`, `cloud_show.rs`
  (`CloudOutputHealth`, `CloudOutputFaults`, `RunnerState.output_health`,
  `CloudStatus.output_health`, `CloudStatus::room_activity` and its test),
  `main.rs` (lease refusal). `cargo fmt --all` was run (it parses); nothing
  was built or tested.
- `pnpm smoke:cloud-parity -- --case health` (runs the web, desktop and Rust
  focused tests, then the scenarios on the real-page baseline with short
  dev-build thresholds), WB, C, RC and REL gates.
- `live_status.rs` is unchanged: S25 (in progress elsewhere) owns the live
  page's room activity; S26 did not race it.

## Files

Desktop: `apps/desktop/src/shared/{cloud-program-health,cloud-room-activity}.ts`
(+ test), `apps/desktop/src/main/{live-activity,exit-guard,index}.ts`
(+ test), `apps/desktop/src/shared/{backend,backend-rpc-contract}.ts`,
`apps/desktop/src/renderer/src/components/tabs/{cloud-program-health,diagnostics-tab}.tsx`
(+ page test), `lib/watchdog-{view,rank}.ts`, `components/streaming/watchdog-section.tsx`,
`hooks/use-studio.tsx`, the Rust files above, `protocol-fixtures/cloud-parity-health.json`,
`scripts/lib/cloud-parity-health{,-contract}.mjs` (+ test),
`scripts/lib/{cloud-parity-baseline,fake-cloud-web-managed}.mjs`,
`scripts/smoke-cloud-parity-app.mjs`, `docs/cloud/managed-media-wire.md`.

Web: `lib/cloud/media/output-health.ts`, `lib/cloud/program/faults.ts`,
`lib/cloud/{media/state,media/events,program-route}.ts`,
`lib/cloud/program/{beacon,stage,wire,tools/emit}.ts`, `lib/alerts/push.ts`,
`db/schema.ts` (JSON column type only, no migration), emitted
`public/cloud/program/v1/{beacon,faults,stage,wire}.js`,
`tests/cloud-program-health.test.ts`, `tests/fixtures/cloud-parity-health.json`.
