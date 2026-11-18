# Plan 249 S8: system audio and deliberate takeover routing

Status: **integrated on the published S13a and S24 tips, uncommitted.** Source
wiring, the S13a clock, the S24 controller wiring, focused tests and the
maintained `audio-routing` acquisition are in place. The acquisition was
authored, not run. The native system source stays disabled by default and
unqualified; no drift, latency, A/V alignment or speaker AEC is claimed. No
commit, push, PR, merge or deploy. The central ledger and the parity
plan/inventory JSON were not edited. Exact per-file SHA-256 and trees:
`docs/cloud/249-s8-manifest.json` (same file in both repos).

## Ownership and history

- Built standalone by a Codex agent (G67rq) on S7b and frozen on 2026-11-16
  (desktop `/Users/orcdev/projects/videorc-wt-249-s8` on `68c623f07`, 38
  paths; web `/Users/orcdev/projects/videorcweb-wt-249-s8` on `59fb8ba6`, 17
  paths). Its frozen manifests (`/tmp/249-s8-{desktop,web}-frozen.json`,
  SHA-256 `b254035b…` and `23b201b8…`) are copied to `~/s8-scratch/frozen/`;
  every listed file still matched them. Those trees were not edited.
- 2026-11-17: the coordinator (G3l7j) moved S8 to this thread (G98zv) with
  G67rq read-only. The integration lives in new trees below.

## Trees and bases

- Desktop `/Users/orcdev/projects/videorc-wt-249-s8i`, branch
  `feat/249-s8-integration`, HEAD = origin/main
  `4ff7156818f425112ef3575ff102cfdfdea853d7`.
- Web `/Users/orcdev/projects/videorcweb-wt-249-s8i`, branch
  `feat/249-s8-integration`, HEAD = origin/main
  `ab811051b29345ee13ae7686c4534892de6fe077`.
- **Staged in the index (prerequisites, not S8):**
  - Desktop tree `72f3cde109b00cf5d8a99deb6f26ea27ff5b47b6` = main + repair
    #1457 `1f372525d402f5e58118df36f052e50f0816ccf6` + S24 #1461
    `7c2e0ed519417a4132c6670a982907d4b80b1ddd` + S13a #1459
    `3e42ca9af06fbff8f646b58823b6c29405e92e43`. No conflicts; equal to
    `git merge-tree` of S24 and S13a plus the #1457 diff.
  - Web tree `c5df48291b302e9e6d5a1d42988ced15088cbb05` = main + S24 #142
    `db7ce88e5de3e2f878ccf0be3d57c1aaeb08cebb` + S13a #140
    `952ce7b554791551d4d58198726354afa90785ed`. Equal to `git merge-tree`.
- **S8 is the unstaged and untracked delta on that index**: 41 desktop paths,
  15 web paths (the manifest lists them).
- `node_modules` symlinks are not deliverables.

## Porting the frozen checkpoint

Conflicts against main, S13a and S24, all resolved keeping both sides:

- Desktop:
  - `main.rs` module list and connection-owned bridges (S13a frame bridge
    beside S8 system audio).
  - IPC contract imports and count (S13a +2, S8 +2: 190).
  - `main/index.ts` (S13a frame IPC beside S8 system IPC) and the PCM bridge
    test (both new tests).
  - `use-studio.tsx` smoke presets (S12 scene presets beside S8 routing).
  - `room-pcm-bridge.ts`: S13a's open reply check applies to the system
    method too; system frames keep their own parser.
  - `cloud-parity-baseline.mjs`: the case name chain and lanes, and the
    `audio-routing` exercise moved into main's restructured flow, after the
    replay ring and before the soundboard case.
- Web:
  - `overlays.ts`: S8's `isShown` duplicated main's; dropped, so the file is no
    longer part of S8.
  - `stage-audio.ts`: PR118 (#118, now on main) and S8 merged. Without
    deliberate routing a takeover is PR118's whole-program fade on the bus
    (its tests pass unchanged); with routing the speech and auxiliary buses
    carry the gains and a takeover gates speech only. `setSilenced` is
    required again, with PR118's fade constants.
  - `stage.ts`: main's `followTakeover` is folded into S8's `followRouting`,
    which sets both the routing and the takeover silence at the same points.
  - `source.ts`, `tools/emit.ts`: both imports and modules. Browser modules
    re-emitted; emitter `--check` is clean.

## Integration added here

### S13a clock on the system source

- `room_system_audio.rs`: the generation epoch is taken once at open and
  placed on the shared anchor (`room_clock::origin_us`, `incarnation`). The
  open reply is `{generation, originUs, incarnation}`, like S7a/S7b, and
  every frame carries both (null when unavailable, never zero, never
  skipped). A pull whose `originUs + observedAtUs` passes 2^53 - 1 is refused
  before draining.
- Timeline: `originUs + firstSampleUs` is the **capture** timeline (native
  capture time of the first sample; a discontinuity stays a jump), not the
  microphone's processed timeline.
- `room-system-audio.ts`: clock fields required and validated with S13a's
  `validPcmClock` (now exported from `room-pcm.ts`, unchanged otherwise);
  `systemNativeCaptureUs`; fixture `room-system-audio.json` gains `clock`
  and `clockQualification: "unavailable"`.
- Renderer `native-frame` diagnostics add `originUs`, `incarnation`,
  `nativeCaptureUs` and `timeline: "capture"`.

### S24 controller

- No epoch of its own. `systemControllerStep` (pure, in
  `room-audio-routing.ts`) turns system capture off on a first epoch that is a
  takeover, on any later epoch (the same show too) and on a loss
  (`controller.lost` or `stoppedBy`). The aux sink closes the source through
  its serialized teardown; the publisher's existing close/loss disarm stays.
- `use-talk-show-room.ts` reports `system` in S24's existing
  `cloud.controller.desired` beside camera and microphone: true only while
  capturing in an open room. The web merges `enabled` key by key. After a
  takeover the successor sees `system` in `needsEnable` (S24's notice) and
  starts with it off.

### Fixes found while integrating

- `room-aux-publisher.ts`: the frozen S8 ran its 1 s pulse forever, which
  main's "no timer while idle" room test caught. The pulse now runs only while
  a source is on or a routing-capable program page holds a lease to renew.
- `main.rs`: the error code `system audio-refused` (with a space) is now
  `system-audio-refused`, without the borrow #1457 removed for clippy.
- `cloud-parity-audio-routing.mjs`: cleanup no longer throws from `finally`
  (oxlint `no-unsafe-finally`), so a cleanup failure never hides the
  acquisition's own failure; both still fail the case.

## Maintained acquisition (authored, NOT run)

```sh
VIDEORC_PARITY_WEB_ROOT=/absolute/clean/web-checkout pnpm smoke:cloud-parity -- --case audio-routing
```

Local LiveKit, real Electron main/preload IPC, the debug native gate
(`VIDEORC_ROOM_NATIVE_SYSTEM=1`), macOS `/usr/bin/afplay` as the owned external
660 Hz stimulus. Distinct tones for host mic 440, soundboard 1000, guests
880/1320, S6 guest screen 1760. It checks the final program limiter output and
the real guest returns for every documented route, takeover/clear with
operator mutes kept, program-only mutes, monitor one-copy invariance, the
selected screen owner never hearing itself (S6, now on main), compatibility
silence, and real close/reopen cycles with resource release. New here:

- `deriveSystemClock`: one incarnation per run, a fixed origin per generation,
  a later generation never earlier on the anchor, safe sums, null never zero;
  every capture generation must report clock observations.
- The controller's `system` report, read from S24's fake web
  (`h.web.hooks.controller`): true once capturing, false after each release.

Bounds: `VIDEORC_PARITY_AUDIO_SECONDS` 3 (3–8), `VIDEORC_PARITY_AUDIO_CYCLES`
3 (2–5), `VIDEORC_PARITY_AUDIO_DEADLINE_MS` 240000 (60000–600000). Local decoded
routing evidence only: no managed output, physical microphone/AEC or Windows
qualification.

## Focused checks (lightweight only)

- Desktop `tsc --noEmit` (node and web projects): pass.
- Desktop Vitest, 45 files / 789 tests: pass (room, PCM, frame, microphone,
  system audio, aux publisher/sink, routing, avatar/graphics publishers,
  presentation restore, talk-show room and hook, IPC and security contracts,
  `studio-provider.integration`). The publisher file was rerun after its last
  edit: 5/5.
- Node `scripts/lib/cloud-parity-*.test.mjs` + `fake-cloud-web-controller`:
  101/101.
- rustfmt (edition 2024) on `main.rs`, `room_system_audio.rs`: pass. Rust
  **not compiled or run**.
- Prettier, `git diff --check`, no added em dash: pass. oxlint: only the
  existing `no-control-regex` in `fake-cloud-web-managed.mjs` and the
  `use-studio.tsx` warning (both on main).
- Web `tsc --noEmit --incremental false`, ESLint and Prettier on the delta,
  emitter `--check`: pass. 31 program/guest/controller/presentation test
  files: 321 of 328 pass; the same 7 fail on a pristine export of the
  prerequisite tree (S13a camera-frame away timing, six tests, and the
  program luma colours); S8's 5 new tests pass.
- Shadscan `@shadscan/cli` 0.1.0-rc.7 score: desktop 27 -> 27, web 47 -> 47
  (baselines on pristine prerequisite exports).

## Publication

- Order: #1457, then S13a (#1459, web #140) and S24 (#1461, web #142), then
  S8. When main's tree after those merges equals the prerequisite tree above,
  S8 is one commit per repo with the manifest's tree on that main.
- **S17 (#1460) conflicts with the prerequisites**, independent of S8:
  `cloud-parity-baseline.mjs` against S24 and `shared/backend.ts` against
  S13a. Both are unions (case names; one import line each).
- If S17 lands before S8, the manifest's `alternateTrees.afterS17` is S8 on
  prerequisites + S17 with those unions and S8's own three (`use-studio.tsx`,
  `backend.ts` imports, the baseline case chain) resolved. Desktop typecheck
  and harness tests pass on it. The web has no overlap with S17.
- Deploy the web first. Either order is safe: a desktop sends routing only to
  program pages that advertise `audioRouting: 1`; others keep PR118's
  compatibility silence. Pages loaded before PR118 need a reload.

## Deferred gates

D, B (`cargo fmt --check --all`; `cargo test -p videorc-backend
room_system_audio` and the S13a/S24 filters; clippy `-D warnings`, on main
with #1457), N, W, WB, C, R, `pnpm smoke:system-audio`, both soundboard
smokes, `pnpm smoke:cloud-parity -- --case audio-routing`, final-artifact A/V,
Windows and device acceptance, managed output. No production qualification.

## PR text for the coordinator

Desktop title: **Plan 249 S8: add opt-in system audio and deliberate takeover
routing**

> Adds a room-owned, disabled-by-default native system-audio source using the
> existing own-app-excluded capture, mixed into the single host auxiliary
> track with its own consent, gain and mute; the soundboard stays one copy
> with monitoring independent. Program speech and auxiliary gains are
> negotiated with the program page: a takeover gates program speech while
> deliberately enabled auxiliary continues, and an operator mute survives the
> clear. System frames carry S13a's shared clock origin and incarnation on the
> capture timeline. System capture follows S24's controller epoch: it starts
> off after a takeover, on any new epoch and on loss, and is reported through
> `cloud.controller.desired`. Includes the maintained `audio-routing` parity
> case with clock and controller checks (not run). Rust not compiled; smoke,
> device and managed gates deferred. Base: main after #1457, #1459 and #1461.

Web title: **Plan 249 S8: separate program speech and auxiliary takeover
gains**

> Extends media-v2 with negotiated audio routing. Only bounded, fresh packets
> from the current host session set program speech and auxiliary gains, both
> into the one final limiter. A takeover mutes speech and keeps enabled
> auxiliary; pages without routing keep PR118's whole-program fade. A lost
> routing lease fails silent with a diagnostic. Emits matching browser
> modules and adds routing, lease and limiter tests. Deploy before the
> desktop. Base: main after #140 and #142.
