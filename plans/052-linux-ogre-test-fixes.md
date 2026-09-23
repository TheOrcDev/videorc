# Plan 052: Linux after the ogre test — safe VAAPI, a working encoder bridge, an honest gate

> Executor: S0 is an owner decision. S1, S2 and S4 are Diagnose/Implementation
> work in an isolated worktree of current main; each needs a run on the ogre box
> (Omarchy, Hyprland) because portals, `/dev/dri` and `/proc` semantics are not
> reproducible on macOS or in CI. Read AGENTS.md and `docs/linux-port-plan.md`
> first. Planning authorizes no merge and no release.

## Status and decisions

- Status: IN PROGRESS 2026-09-24 on `feat/linux-ogre-test-fixes`. Code for
  S1–S6 is implemented and gated on macOS (targeted Rust tests, clippy, TS
  typecheck/lint/format, script tests, desktop unit tests); the Linux-only
  Rust arm compiles under a temporary test cfg on macOS and the `Linux` CI
  job is its real compile gate. Still owed on ogre: the S1 quarantine check,
  the S2 matrix runs with OpenH264 and VAAPI on `renderD128` (the stderr
  tail is still the missing verdict), the S3 full acceptance evidence, the
  S4 single-instance smoke, and the S5 screenshot. S0a and S0b were taken as
  recommended and are recorded in `docs/linux-port-plan.md`.
- Investigated against `origin/main` `aa1c4b7a`
  and the tester report "Videorc Linux test report — ogre" (2026-09-24 00:16
  CEST). The report's logs and screenshots live only on ogre under
  `~/Projects/videorc-linux-test/`; nothing from ogre was reachable from this
  machine (`ssh ogre` does not resolve), so every root cause below that needs
  a log line is marked as a hypothesis with the exact verification step.
- Priority: S1 and S2 are P0. S3 and S4 are P1. S5 and S6 are P2. Effort:
  S1 M, S2 M (diagnosis first), S3 S, S4 M, S5 S, S6 S.
- Owner routes and lanes: S1 **Implementation** (fit 9, `fable-5`, host-safety
  logic on a multi-GPU box). S2 **Diagnose** (fit 10, `fable-5`, already
  failed once). S3 **Implementation** (fit 8, `gpt-5.5`). S4 **Diagnose**
  (fit 9, `fable-5`). S5 **UI/Product Design** (fit 8, `opus-4.8`). S6 docs
  (`Composer 2.5`).
- **Decision needed from the owner (S0a): which box is the named Linux
  tester?** `docs/linux-port-plan.md` and
  `scripts/lib/linux-encoder-acceptance.mjs:61-66` make Ubuntu 24.04 the only
  host that can emit `complete: true`. ogre runs Omarchy (Arch family).
  Recommended: split the two meanings that are currently one check. The
  *encoder contract* (pinned static FFmpeg, `/dev/dri`, V4L2) is
  distribution-independent and should accept any named physical Linux x64
  box with the distribution recorded in the evidence. The *support baseline*
  (Ubuntu 24.04 AppImage, L6) stays Ubuntu. ogre becomes the named L1.5–L5
  tester; Ubuntu 24.04 is still required before L6 publishes.
- **Decision needed from the owner (S0b): is an AMD ban product policy?**
  No. The hang is specific to this T2 MacBook Pro's Radeon Pro 555X (SMU
  firmware reload fails after a GPU reset, `GPU Recovery Failed: -22`). Most
  Linux boxes with amdgpu encode fine through VAAPI. The product fix is
  crash-safe probing plus an explicit device pin (S1), not a driver blocklist.
  ogre keeps its local `safe-gpu.env` and never probes `renderD129` again.

## What happened (verified against the code)

1. **The host crash was not caused by the app.** The tester ran a standalone
   FFmpeg VAAPI probe against `/dev/dri/renderD129` (amdgpu). The app itself
   never touched that node on ogre: `probe_linux_vaapi_encoder`
   (`crates/videorc-backend/src/recording.rs:11267-11296`) walks
   `/dev/dri/renderD*` in sorted order and returns at the first success, and
   `renderD128` (i915) passed first.
2. **But the app can reproduce the crash on its own.** Three gaps:
   - Every `start_session` re-runs the probe over every render node
     (`recording.rs:11298-11313`); there is no cache and no way to pin a node.
     If `renderD128` ever fails (driver update, device busy, a transient
     `iHD` error), the loop moves straight to `renderD129` and hangs the host.
   - The 15 s probe timeout cannot rescue a kernel-level GPU hang. Once the
     command stack on that node is lost, the whole session collapses
     regardless of what the backend does next.
   - Packaged builds auto-run the performance ladder at first launch
     (`apps/desktop/src/renderer/src/hooks/use-studio.tsx:12090-12100`), so a
     future Linux AppImage would probe every GPU on first open with nothing
     remembered from a previous crash.
3. **In-app recording failed on the safe GPU.** With auto selection the ladder
   picked `renderD128`, then every rung (1440p, 1080p, 720p) died with "Broken
   pipe" / FFmpeg progress timeout. The standalone CLI encode on the same node
   passed. Two design gaps make a passing probe uninformative:
   - The probe (`recording.rs:11202-11228`) encodes 3 black frames at 128x72
     with `-b:v 1000k` and no rate-control mode. The real session adds
     `-rc_mode VBR` (`recording.rs:11391-11395`), `-maxrate` equal to the
     bitrate and `-bufsize` double it (`recording.rs:11446-11449`),
     `-profile:v high -level <n>`, colour tags, and a filter chain that runs
     `scale=…,setparams=…,format=nv12,hwupload` after the compositor
     (`recording.rs:16243-16248`, `15333-15344`). None of that is exercised
     before the session commits to VAAPI.
   - "Broken pipe" is the *consequence* of the stop ladder killing FFmpeg
     after the progress timeout, not the verdict (same lesson as the
     multistream EPIPE fix). The real reason is in the FFmpeg stderr tail the
     backend keeps (`FfmpegStderrTail`, `recording.rs:892`, summarised at
     `4828`) and was never surfaced in the report.
   - The software path was **never run in-app** on ogre. The ladder ran in
     auto mode (VAAPI) before the crash; after the reboot the app was only
     left idle under `VIDEORC_LINUX_H264_ENCODER=openh264`. "In-app encoder
     bridge broken on Linux" is therefore proven for VAAPI on `renderD128`
     only. OpenH264 in-app is unproven, not failed.
4. **The Ubuntu typed failure is the gate working as designed** (see S0a).
5. **`smoke:backend-single-instance` timed out on "first backend to be
   reaped".** Two Linux-only gaps, both in
   `apps/desktop/src/main/backend-owned-processes.ts`:
   - Leading hypothesis: identity captured before the rustup proxy execs. Dev
     mode spawns `~/.cargo/bin/cargo run …` (`apps/desktop/src/main/index.ts:
     7886-7889`, `8216-8218`) and records the pid immediately after spawn
     (`index.ts:8290`). `record()` probes identity at once
     (`backend-owned-processes.ts:194-207`), and on Linux that probe is a
     microsecond `/proc/<pid>/exe` readlink (`532-547`), which runs before the
     rustup proxy `exec`s the toolchain `cargo`. The second launch then sees a
     different `executablePath`, classifies the record as an identity
     mismatch (`372-386`), drops it, and never sends a signal. On macOS the
     `ps` probe is slow enough that the exec has already happened, which is
     why the smoke passes there.
   - Second gap: `probeLinuxProcess` never reads the state field of
     `/proc/<pid>/stat`, so a zombie (`Z`) counts as live and gets
     `unprobeable` once its `exe` link vanishes, which retains the record and
     refuses replacement startup. The smoke's own `processExists` in
     `scripts/smoke-backend-single-instance.mjs:76-83` has the same blind spot.
6. **Native preview is "not built on linux"** because L5 is not started. The
   Studio copy says "Native preview is disabled" with a retry button
   (`apps/desktop/src/renderer/src/components/preview-stage.tsx:414`) and the
   Preview window says "Waiting for preview" (`index.ts:3712`). Both imply a
   fault the user can fix. Diagnostics already use a neutral tone for
   `previewTransport: 'unavailable'` (`diagnostics-tab.tsx:1166`).
7. **`systemPreferences.getMediaAccessStatus` is not a function on Linux.**
   `readMediaAccessStatus` (`index.ts:11563-11570`) catches the TypeError,
   logs a warning and returns `unknown` on every
   `system:media-access-status` IPC call (`index.ts:12545`).
   `assertPermissionShortcutSupported` already refuses Linux
   (`apps/desktop/src/main/runtime-info.ts:84-88`).
8. **Packaging** has only `mac:` and `win:` sections
   (`apps/desktop/electron-builder.yml:39`, `:101`). L6, unchanged.
9. **Camera access needed `usermod -aG video,render` plus an ACL.** That is a
   distro/udev matter, not a bug, but it belongs in the L3 prerequisites.

## Out of scope

- L2 audio, L3 camera, L4 portal capture, L5 CPU preview, L6 AppImage. They
  are unbuilt phases, not regressions; the vault handoff
  `plans/planned/2026-08-22 - Videorc Linux Port Handoff.md` still owns them
  and stays blocked behind S2 passing and the S0a decision.
- Any change to macOS or Windows encoder selection.
- A driver blocklist for amdgpu (S0b).

## Ordered slices

### S0 — owner decisions (no code)

- S0a and S0b above. Record both in `docs/linux-port-plan.md` under a new
  "Named tester boxes" table: ogre, T2 MacBook Pro, Omarchy 4.0.4, i915
  `renderD128` allowed, amdgpu `renderD129` quarantined with the crash date.
- Done when: the two decisions are written in the doc and this plan's status
  line is updated.

### S1 — render-node safety on multi-GPU Linux (P0, backend)

Files: `crates/videorc-backend/src/recording.rs` (Linux arm only), new
`crates/videorc-backend/src/linux_vaapi.rs` if the arm grows past ~200 lines.

1. `VIDEORC_LINUX_VAAPI_DEVICE=/dev/dri/renderDNNN`: when set, `auto` and
   `vaapi` probe only that node; a bad value is a typed startup error.
2. Driver-aware candidates: for each `renderD*`, read
   `/sys/class/drm/<node>/device/driver` (symlink basename: `i915`, `xe`,
   `amdgpu`, `nouveau`, …) and log `node -> driver` once per backend
   lifetime. Ordering stays sorted; the driver is evidence, not policy.
3. Crash-safe probing: before probing a node write
   `<app-data>/linux-vaapi/probe-in-progress.json` `{node, driver, startedAt,
   ffmpegSha}`; delete it after the probe returns (pass or fail). At backend
   start, a leftover file means the previous probe never returned: move it to
   `quarantined.json` (append), log at `warn`, expose it in diagnostics, and
   never probe that node again unless `VIDEORC_LINUX_VAAPI_DEVICE` names it
   explicitly. This is the same posture browsers take for GPU crashes.
4. Probe once per backend lifetime per FFmpeg path, not per session. Cache
   the `ResolvedFfmpegH264Encoder`; a forced `openh264` session does not
   invalidate it.
5. Diagnostics: `bridgeDiagnostics` gains `linuxRenderNodes:
   [{node, driver, state: probed-ok | rejected | quarantined | skipped}]`.
6. Tests (`cfg(test)` on all platforms as the existing Linux helpers are):
   env pin parsing, candidate/driver listing against a temp `/sys`-shaped
   directory, quarantine round trip, cache reuse.

Done when: `cargo test -p videorc-backend` passes with the new tests; on ogre,
with `VIDEORC_LINUX_VAAPI_DEVICE=/dev/dri/renderD128`, the backend log shows
exactly one probe and `renderD129` is listed as `skipped`; deleting the pin
and planting a stale `probe-in-progress.json` for `renderD129` produces
`quarantined` without any FFmpeg process touching that node (verify with
`strace -f -e openat` or the FFmpeg log).

### S2 — the in-app encoder bridge on Linux (P0, diagnose then fix)

Diagnosis first, on ogre, always under `~/.local/bin/videorc-dev`'s safe env
and never with a second dev instance running:

1. Software path, bypassing the distro gate by calling the matrix directly:
   ```bash
   VIDEORC_LINUX_H264_ENCODER=openh264 VIDEORC_MATRIX_ONLY=1080p30 \
   VIDEORC_MATRIX_PRINT_BRIDGE_DIAGNOSTICS=1 \
   VIDEORC_SMOKE_FFMPEG_PATH=$PWD/vendor/ffmpeg/linux-x64/bin/ffmpeg \
   node scripts/smoke-recording-matrix-app.mjs
   ```
   This answers whether the bridge (compositor → raw pipe → FFmpeg) works on
   Linux at all. If it fails, the bug is upstream of the encoder.
2. VAAPI on the safe node, same command with `VIDEORC_LINUX_H264_ENCODER=vaapi
   VIDEORC_LINUX_VAAPI_DEVICE=/dev/dri/renderD128` (after S1; before S1 use
   the existing `LIBVA_*` pin, which does not stop the probe loop, so only run
   it once `renderD128` is known to pass the probe).
3. Capture the backend log's FFmpeg stderr tail for the failing rung; that
   line is the verdict. Candidates to check against it, in order:
   - `-rc_mode VBR` with `-maxrate == -b:v` on iHD (the driver expects
     maxrate above the target for VBR; use CBR when they are equal or raise
     maxrate for the VAAPI arm only).
   - `-level` rejected or profile/level mismatch on `h264_vaapi`.
   - `hwupload` failing because the frames arrive as `bgra` from the raw pipe
     and the `scale` output format is not nv12-compatible on this driver.
   - Startup latency: the first VAAPI frame can take longer than the output
     progress fence allows; the fence must wait for the first encoded packet,
     not a fixed budget.
4. Make the probe honest: probe with the session's real encode args
   (`append_h264_encoding_args_for_platform_with_timing`) at the session's
   width/height/fps and the bridge filter chain, for ~30 frames. A probe pass
   then predicts a session pass. Keep the tiny 128x72 probe only as the
   quarantine sentinel's first touch.
5. Surface the rejection reason and stderr tail in `bridgeDiagnostics` and in
   the backend log at `info` (software fallback remains a non-toast event per
   the quality-toast rules).

Done when: on ogre, the 1080p30 matrix passes in-app with
`bridgeDiagnostics.encodeBackend = software-open-h264` and with
`hardware-vaapi` on `renderD128`; the performance ladder completes with a
recommendation instead of three failures; `cargo test -p videorc-backend`
and `cargo clippy -p videorc-backend -- -D warnings` pass.

### S3 — the acceptance gate records the box instead of rejecting it (P1)

Files: `scripts/lib/linux-encoder-acceptance.mjs`, its test,
`scripts/smoke-linux-encoder-acceptance.mjs`, `docs/linux-port-plan.md`.

1. Per S0a: drop the `ID === 'ubuntu' && VERSION_ID === '24.04'` check from
   `assessLinuxEncoderAcceptanceHost`; keep Linux x64, tester name, machine
   name, physical attestation, webcam and render-node checks. Add the
   distribution and kernel to the evidence (`host.distribution` already
   exists; add `host.osReleaseId`, `host.osReleaseVersion`).
2. Add `host.renderNodes: [{node, driver}]` and `host.vaapiDevicePin` so the
   evidence shows which GPU encoded.
3. Update the test: Debian and Omarchy now pass the host check; a VM
   attestation still fails.
4. Doc: the L1.5 section says "any named physical Linux x64 box"; the support
   baseline table keeps Ubuntu 24.04 for L6.
5. Run the full two-backend acceptance on ogre once S2 passes and commit
   `docs/acceptance/linux/2026-MM-DD-ogre-omarchy-l1.5.json` (the small JSON
   evidence only, no recordings).

Done when: `node --test scripts/lib/linux-encoder-acceptance.test.mjs` passes,
`pnpm test:scripts` passes, and ogre emits `complete: true`.

### S4 — owned-process reaping is exact on Linux (P1, desktop main)

Files: `apps/desktop/src/main/backend-owned-processes.ts` and test,
`apps/desktop/src/main/index.ts`, `scripts/smoke-backend-single-instance.mjs`.

1. Verify the hypothesis on ogre before changing code: launch the dev app,
   read `<app-data>/Videorc/owned-processes/global.json`, compare
   `identity.executablePath` with `readlink /proc/<pid>/exe`. A mismatch
   (`~/.cargo/bin/cargo` versus `~/.rustup/toolchains/…/bin/cargo`) confirms
   the pre-exec capture.
2. Fix A: in dev mode resolve the toolchain cargo directly
   (`rustup which cargo`, fallback to the proxy) so the recorded process never
   execs. Fix B, belt and braces: re-stamp the identity when the backend
   reports READY; if the birth token matches and only the path changed,
   replace the record rather than treating it as a mismatch. Packaged builds
   are unaffected by either.
3. Zombies are dead: parse the state field of `/proc/<pid>/stat` in
   `probeLinuxProcess`; `Z` and `X` return `dead`. Mirror that in the smoke's
   `processExists` on Linux.
4. Unit tests through the injected `probeProcess`: exec-path change with the
   same birth token after READY, zombie state, unchanged Windows/macOS arms.

Done when: `pnpm --filter @videorc/desktop test` passes and
`pnpm smoke:backend-single-instance` passes on ogre while `videorc-dev` is
running in its own app-data directory. Document that mutual exclusion in the
Linux dev-loop doc (S6).

### S5 — honest Linux copy for preview and permissions (P2, UI)

Follow `.claude/skills/videorc-design/SKILL.md`; shadcn only.

1. `readMediaAccessStatus`: on Linux return a new `not-applicable` status
   without logging; the renderer chips hide themselves for that value instead
   of rendering an unknown state. No warning per IPC call.
2. Preview stage on Linux: replace "Native preview is disabled" + retry with
   "Preview isn't built for Linux yet. Recording still works." and no retry
   button; the Preview window placeholder says the same instead of "Waiting
   for preview". Keyed on `runtimeInfo.platform === 'linux'`, not on the addon
   load error string.
3. Tests: the existing studio-provider integration tests gain a Linux runtime
   case for both.

Done when: `pnpm typecheck`, `pnpm lint`, `pnpm --filter @videorc/desktop
test` pass and a screenshot from ogre shows the new copy.

### S6 — docs (P2)

1. `docs/linux-dev-loop.md` mirroring `docs/windows-dev-loop.md`: required
   groups (`video`, `render`) and the udev ACL fallback, the safe-GPU env,
   `VIDEORC_LINUX_VAAPI_DEVICE`, "one dev instance at a time", where the logs
   are, and the never-do list from the report (no parallel encode probes, no
   encode on a quarantined node).
2. `docs/linux-port-plan.md`: the named tester table (S0), the render-node
   policy (S1), the honest probe (S2), the widened gate (S3), and an L3 note
   that camera access depends on group membership.
3. `AGENTS.md`: add the Linux commands beside the Windows ones.

Done when: the diff reads correctly and `pnpm format:check` passes.

## Verification summary

- Rust: `cargo fmt --check --all`, `cargo test -p videorc-backend`,
  `cargo clippy -p videorc-backend -- -D warnings`, plus
  `cargo build --release` after any `cfg` edit.
- Scripts: `pnpm test:scripts`.
- Desktop: `pnpm typecheck`, `pnpm lint`, `pnpm --filter @videorc/desktop test`.
- On ogre only: the S1 quarantine check, the S2 matrix runs, the S3 full
  acceptance, the S4 single-instance smoke, the S5 screenshot.

## Known blockers

- Every ogre step needs the box awake and nobody else running a dev instance
  on it. The always-on inhibitor is active; Grok Bot autostart also runs there.
- `renderD129` on ogre must never be probed, even by S1's tests. Plant the
  quarantine file by hand before the first S1 run on that box.
- The L1.5 `complete: true` evidence still requires the S0a decision; without
  it, S3 cannot land.
