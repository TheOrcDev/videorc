# Plan 053: Linux L1.5 goes green on ogre — colour tags, the Intel VAAPI error, the stale reap assertion

> Executor: S1–S3 are code slices in an isolated worktree of current main;
> S2 and S3 each need one run on the ogre box (Omarchy / Hyprland). S4 is the
> evidence run. Read AGENTS.md, `docs/linux-dev-loop.md` and Plan 052 first.
> Never probe `/dev/dri/renderD129` on ogre; it stays quarantined. Planning
> authorizes no merge and no release.

## Status and decisions

- Status: IN PROGRESS 2026-09-24 on `feat/linux-l15-green`. S1, S2, S5 and
  the code half of S3 are implemented (probe command logged, standard-then-
  compat probe, compat profile in diagnostics). The compat argument set is
  PROVISIONAL until the S3 bisect runs on ogre; S4 evidence still needs the
  box.
- Investigated against `origin/main` `a93c49ce`
  (Plan 052 merged) and the ogre report of 2026-09-24 09:35 CEST. The report's
  artifacts and logs live only on ogre under `~/Projects/videorc-linux-test/`.
- Priority: S1 P1 (small, unblocks the smoke), S2 P0 (it is the last gap
  between the working OpenH264 path and a green L1.5), S3 P1, S4 P1, S5 P2.
  Effort: S1 XS, S2 S, S3 M, S4 S, S5 XS.
- Owner routes and lanes: S1 **Implementation** (fit 8, `gpt-5.5`). S2
  **Implementation** (fit 9, `fable-5`: it changes the shipped bitstream on
  two platforms). S3 **Diagnose** (fit 10, `fable-5`: real-device bisect
  first, then a driver-compat arg profile). S4 **Release**-style evidence
  (fit 8, `gpt-5.5`). S5 docs (`Composer 2.5`).
- No owner decision is needed. Plan 052's S0a and S0b stand: ogre is the
  named L1.5–L5 tester, Ubuntu 24.04 stays the L6 baseline, no amdgpu
  blocklist.

## What the second run showed, against the code

1. **OpenH264 records in-app now.** `encodeBackend = software-open-h264`,
   `encoderBridgeError = null`, 1920x1080 at ~30 fps. The matrix fails on
   exactly one thing: `color_primaries=unknown`, `color_transfer=unknown`
   (`color_space=bt709` and `range=tv` are present). Root cause in the code:
   the software arm relies on the output flags from
   `h264_bt709_color_tag_args` (`crates/videorc-backend/src/recording.rs:
   11813`, `11821-11832`), but FFmpeg's `libopenh264` wrapper does not write
   VUI colour description into the SPS, so the bitstream carries nothing and
   the container-level tags only partially survive the remux. The codebase
   already has the deterministic fix for exactly this situation on the
   Windows Media Foundation copy path:
   `append_media_foundation_h264_color_metadata_args`
   (`recording.rs:15624-15630`) adds
   `-bsf:v h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1`,
   which rewrites the SPS VUI after encoding. It is only applied to
   `WindowsMediaFoundationH264MpegTs`. The `LinuxSoftware` and
   `WindowsSoftware` (libopenh264) arms never get it. The bundled BtbN LGPL
   builds ship the `h264_metadata` filter (the Windows path already depends
   on it).
2. **VAAPI on the Intel node fails honestly now.** The real-args probe (Plan
   052) reports `Failed to end picture encode issue: 24 (internal encoding
   error)`; the standalone 720p CLI encode on the same node passes. The
   session arg set for `LinuxVaapi` is `-rc_mode VBR` with `-maxrate` equal
   to `-b:v` and `-bufsize` double it, `-profile:v high -level 4.0`, `-g 60`,
   `-force_key_frames`, `-flags +global_header`, BT.709 tags, B-frames left
   at the driver default (`-bf 0` only under low latency), fed
   RGBA → `format=nv12,hwupload` at 1920x1080 (`recording.rs:11778-11783`,
   `11803-11818`, `15684-15696`). Which of those the iHD driver on this
   Coffee Lake part rejects is unknown; it has to be bisected on the box.
   Nothing in the backend logs the probe's exact command line yet, so the
   tester cannot reproduce it verbatim.
3. **The single-instance smoke assertion is stale product-wide, not a Linux
   gap.** The first backend is now reaped within the 5 s window (Plan 052's
   S4 worked), and the run fails only on
   `second launch should log reaping the first backend`. The smoke greps for
   a line containing `Reaping` and the pid
   (`scripts/smoke-backend-single-instance.mjs:24`). No such line exists in
   the app: the only reap log is
   `Confirmed N stale owned process record(s) dead after reaping M live pid(s): <label>:<pid>`
   (`apps/desktop/src/main/index.ts:7805`). The smoke is not part of
   `smoke:local-gates`, which is why the drift went unnoticed.
4. **Host gate and quarantine work as designed.** Omarchy passes the host
   check; `renderD129` sits in `~/.videorc/linux-vaapi/quarantined.json` and
   was never probed. Nothing to change.

## Out of scope

- L4 portal capture, L5 preview, L6 packaging (vault handoff
  `plans/planned/2026-08-22 - Videorc Linux Port Handoff.md`).
- Any change to macOS VideoToolbox or Windows Media Foundation arguments.
- amdgpu on ogre.

## Ordered slices

### S1 — the single-instance smoke asserts the real log line (P1, XS)

File: `scripts/smoke-backend-single-instance.mjs`.

1. Match the line the app actually writes: contains `after reaping` and
   `:${firstPid}` (the ledger label plus pid). Keep the `Reaping` match as a
   second accepted form so the process-lifecycle and process-memory smokes,
   which grep `/Reaping/i` for logging only, stay untouched.
2. Make the assertion message name the expected line so the next drift is
   obvious.

Done when: `pnpm smoke:backend-single-instance` passes on macOS and on ogre
(with `videorc-dev` running in its own app-data directory).

### S2 — software H.264 carries BT.709 VUI on Linux and Windows (P0, S)

Files: `crates/videorc-backend/src/recording.rs` and its tests.

1. Rename `append_media_foundation_h264_color_metadata_args` to
   `append_h264_bt709_vui_rewrite_args` (same body) and call it from
   `append_h264_encoding_args_for_platform_with_timing` for
   `FfmpegH264Platform::LinuxSoftware` and `WindowsSoftware`, right after the
   existing `h264_bt709_color_tag_args()` call. The flags keep the container
   honest; the bsf makes the bitstream honest.
2. Also add
   `setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`
   before the encoder in `bridge_recording_video_filter_for_encoder` for the
   software arms, so frames arrive already stamped (matches the legacy
   filter at `recording.rs:16600`).
3. Tests: the existing arg tests for the Linux software and Windows software
   arms assert `-bsf:v` is present with the exact filter string; the VAAPI,
   VideoToolbox and Media Foundation arms assert it is absent (hardware
   encoders build the VUI themselves). The Windows MF copy-path test stays.
4. On ogre: the direct matrix command with
   `VIDEORC_LINUX_H264_ENCODER=openh264` must pass all gates, and
   `ffprobe -show_streams` on the artifact must show
   `color_primaries=bt709`, `color_transfer=bt709`, `color_space=bt709`,
   `color_range=tv`.

Done when: `cargo test -p videorc-backend` and clippy pass; the 1080p30
OpenH264 matrix on ogre reports zero failures; the Windows CI recording
smokes stay green.

### S3 — the Intel VAAPI encode error is bisected and a compat profile lands (P1, M)

Files: `crates/videorc-backend/src/recording.rs`,
`crates/videorc-backend/src/linux_vaapi.rs`, `protocol.rs`, shared TS type.

1. Backend: log the probe's full FFmpeg command at `info` before it runs
   (already bounded, no secrets), so the tester can copy it verbatim.
2. On ogre, pinned to `renderD128`, bisect from the logged command by
   removing one item at a time and re-running until the encode succeeds,
   in this order: `-rc_mode VBR` → `CBR`; drop `-level`; add `-bf 0`; drop
   `-flags +global_header`; drop `-force_key_frames`; 1080p → 720p. Record
   the first passing set and the failing stderr for each step in the ogre
   report. Do not stop at the first pass; also confirm 1080p with that set
   for 10 s.
3. Backend: introduce `LinuxVaapiArgProfile { Standard, Compat }` carried on
   `ResolvedFfmpegH264Encoder`. `Compat` is the arg set found in step 2
   (expected shape: CBR, no `-level`, `-bf 0`; adjust to the evidence). The
   probe tries `Standard` first, then `Compat` on the same node; sessions use
   whichever passed. Diagnostics: `linuxRenderNodes[].detail` names the
   profile and `bridgeDiagnostics` gains `linuxVaapiArgProfile`. If neither
   passes, the existing OpenH264 fallback stands.
4. Tests: arg builder tests for both profiles; a selection test that a
   `Standard` rejection followed by a `Compat` pass yields `LinuxVaapi` with
   the compat profile.
5. Document the driver quirk in `docs/linux-port-plan.md` under the ogre
   tester record.

Done when: the direct matrix with `VIDEORC_LINUX_H264_ENCODER=vaapi
VIDEORC_LINUX_VAAPI_DEVICE=/dev/dri/renderD128` passes on ogre with
`encodeBackend = hardware-vaapi`, and a forced `Standard` still fails with
the same logged reason (so the compat choice is evidence-backed, not a
blind downgrade).

### S4 — the L1.5 evidence record (P1, S)

1. On ogre, after S2 and S3: the full two-backend
   `pnpm smoke:linux-encoder-acceptance` with the tester env, giving
   `complete: true`.
2. Commit the JSON as `docs/acceptance/2026-MM-DD-linux-l1.5-ogre.json` and a
   short `docs/acceptance/2026-MM-DD-linux-l1.5-ogre.md` in the style of
   the Windows record: box, kernel, driver per node, quarantine state, both
   artifacts' ffprobe colour lines, the compat profile if used. No media.
3. Flip the L1.5 row in `docs/linux-port-plan.md` from "hardware proof
   pending" to "proven on ogre <date>", and update the "Hardware stop before
   L2" paragraph: L2 may start.

Done when: the record is on main and the port plan says L1.5 is proven.

### S5 — report drift fixes (P2, XS)

- `docs/linux-dev-loop.md`: add the ffprobe colour check as a one-liner and
  note that `smoke:backend-single-instance` needs S1's assertion.
- `plans/README.md`: Plan 053 entry; Plan 052 entry gets "ogre re-run
  2026-09-24: OpenH264 in-app works, VAAPI@D128 honest fail, gate passes".

## Verification summary

- Rust: `cargo fmt --check --all`, `cargo test -p videorc-backend`,
  `cargo clippy -p videorc-backend -- -D warnings`. The Linux-only arm is
  compiled by the `Linux` CI job; the test module compiles on every platform,
  so keep fixtures free of Unix-only calls and of `Path::is_absolute` on
  Linux paths (both bit Plan 052 on Windows).
- Scripts: `pnpm test:scripts`; desktop: `pnpm typecheck`, `pnpm lint`.
- On ogre only: S1 smoke, S2 and S3 matrix runs, S4 acceptance.

## Known blockers

- ogre must be awake with no second dev instance running; `renderD129`
  stays quarantined throughout.
- S3 cannot be designed further from macOS; the compat arg set is whatever
  the bisect proves, and the plan must be updated with it before S3's code
  lands.
