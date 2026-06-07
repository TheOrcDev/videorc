# Smooth Preview + Correct Recording — Execution Slices

Execution tracker for the remaining work on the shared-compositor preview/recording path.
Real goal (per the 2026-06-07 pivot): **a smooth live preview and a correct recording**.
OBS side-by-side parity is no longer the goal — it survives only as an optional comparison
tool. Perceptual items are judged **by eye on a moving clip**, not by fps/latency numbers
alone (those metrics are blind to judder).

The originating plan (`~/Documents/Obsidian Vault/plans/planned/2026-06-07 - Videorc Real
Time Preview Recording Parity Plan.md`) is ~85% implemented already; these slices cut only
the remaining work.

## Status

| # | Slice | Status | Gate |
|---|---|---|---|
| 1 | Native preview is the confirmed live default | ✅ already wired as default | on-device eye-check (user) |
| 2 | Hardware VideoToolbox zero-copy = adaptive default | ✅ adaptive default shipped | deterministic (cargo test) + on-device gate (user) |
| 3 | "Preparing recording…" UX + copyable preflight report | ✅ done | deterministic (cargo test + typecheck) |
| 4 | Studio health badge + degraded indicator | ✅ done | deterministic (vitest + typecheck + build) |
| 5 | Developer-only synthetic camera source (selectable) | ⬜ todo | deterministic (cargo test) |
| 6 | ProgramFrame contract + parity check (hardening) | ⬜ todo | deterministic (test:scripts) |
| 7 | Visual/timing parity fixtures (hardening) | ⬜ todo | deterministic (test:scripts) |
| 8 | Real-camera product acceptance (closes plan) | ⬜ todo | real-camera by-eye (user) |

Legend: ✅ done · ⏳ in progress / blocked · ⬜ todo.

## Verification policy for this run

- **Deterministic, non-intrusive gates run by the agent:** `pnpm typecheck`, `pnpm build`,
  `cargo test -p videorc-backend`, `cargo clippy -p videorc-backend -- -D warnings`,
  `pnpm test:scripts`.
- **Intrusive / on-device gates deferred to the operator:** the app-launching smokes
  (`pnpm smoke:*`), the real-source baselines (`pnpm baseline:real-source --gate`), and every
  by-eye check. The agent does not autonomously launch Electron windows, trigger capture
  permission prompts, or record files on the live desktop.

## Slice 1 — Native preview is the confirmed live default ✅

No code change required. `ensureNativePreviewRealSurfaceDriver()`
(`apps/desktop/src/main/index.ts:1465`) already makes the native CAMetalLayer preview the
default on macOS with **no env flags**: it auto-spawns the Rust `native_preview_host_helper`
(dev: `cargo run … --bin native_preview_host_helper`; packaged: bundled binary). PNG frame
polling runs only as bootstrap/fallback and is suppressed
(`setNativePreviewSurfaceFramePollingSuppressed(true)`) once the native surface presents.

**Operator gate (by eye):**

1. `pnpm dev`, open Studio with a real camera.
2. Diagnostics tab: confirm `previewTransport = native-surface`,
   `previewSurfaceBacking = cametal-layer`, and `previewImagePollCounts` flat at **0** in
   steady state.
3. Wave a hand fast — preview keeps up, no rubber-banding — both idle and while recording.

## Slice 2 — Hardware VideoToolbox zero-copy = adaptive default ✅

**Recommendation delivered:** default to hardware VideoToolbox **zero-copy** (MPEG-TS) — same
hardware-H.264 quality as the old raw path (both encode via `h264_videotoolbox`), but no CPU
readback / BGRA→YUV conversion, so lower CPU and higher sustained fps under load, plus
VideoToolbox can pick proper HD colorimetry (BT.709). Raw-YUV was never a *quality* downgrade;
the win here is performance.

**Why adaptive, not a blind flip:** in any VideoToolbox mode the compositor publishes
Metal-target-only frames (`publish_yuv_frames: false`, `recording.rs`), so VT must not run
when the scene isn't actually compositing on Metal (Metal off, test patterns, uncached image
overlays) or when sources aren't live (headless smokes have no real camera). A blind flip
would starve the bridge and break the smoke suite.

`recording_encoder_bridge_video_output` now decides per session
(`crates/videorc-backend/src/recording.rs`):

- an explicit `VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT` always wins (forcing a path / pinning a
  smoke to `raw-yuv420p`);
- otherwise `adaptive_videotoolbox_ready` picks VT zero-copy **only** when the live preview is
  already compositing this scene cleanly on Metal (`compositorBackend == metal`, no fallback
  reason) **and** every selected real source has a fresh frame (≤ 500 ms); else raw-YUV.

This keeps headless/no-camera smokes on raw (camera frame stale → raw) and means a wrong guess
is caught by the **startup-barrier preflight** (blocks the start with the Slice 3 report)
rather than writing a bad file. Policy is unit-tested (`adaptive_videotoolbox_*`, 5 cases).

Verified: `cargo test -p videorc-backend` (464 pass), `cargo clippy -D warnings`.

**Operator gate (on-device):** with a real camera + screen, `pnpm baseline:real-source --gate`
should now pick VT by default and pass with `encode backend = hardware-videotoolbox`,
`zero-copy > 0`, startup PASS, final-file PASS; plus a by-eye smooth 60s playback. Smokes that
must stay deterministic on raw should pin `VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT=raw-yuv420p`.

## Slice 3 — Preflight UX + copyable failure report ✅

The hard part already existed: `await_recording_camera_cadence_ready` and
`await_recording_startup_barrier` (`crates/videorc-backend/src/recording.rs`) already
`bail!` and block the start with no file written on timeout. This slice added the
user-facing surface without touching that tuned block logic:

- **"Preparing recording…" label** — the renderer's optimistic start state now reads
  *Preparing recording…* (or *Preparing livestream…*) through the whole cadence-guard +
  startup-barrier window; preview stays live (it's independent of recording state).
- **Copyable failure report** — on preflight failure, `emit_preflight_failure_report`
  builds a structured, owner-tagged report (source / compositor / encoder / camera+screen
  frame ages / maintenance) from the live diagnostics snapshot and emits it as an error
  health event, so it surfaces (copyable) in Diagnostics — the architecturally correct home
  per the "Studio = compact badge, full detail in Diagnostics" decision. The builder
  (`format_preflight_failure_report`) is pure and unit-tested (3 cases).

Verified: `cargo test -p videorc-backend preflight` (3 new pass), `cargo clippy -D warnings`,
desktop `vitest` (40 pass), `typecheck`, `build`. Operator check: start with a covered
camera lens or a disconnected source → start blocks, no file, report appears in Diagnostics.

## Slice 4 — Studio health badge ✅

Added a compact preview-health badge to the Studio action bar plus a degraded strip. The
derivation is extracted to `apps/desktop/src/renderer/src/lib/studio-health.ts` and
unit-tested (`studio-health.test.ts`, 9 cases). Degraded **"Preview may not match
recording"** triggers on compositor CPU fallback (`compositorBackend === 'cpu-fallback'`, or
fallback frames mid-recording); warns on preview present latency over the live budget
(p95 75 ms / p99 150 ms) or an HTTP image-polling transport; otherwise Live/Ready. Verified
deterministically: `pnpm --filter @videorc/desktop test` (40 pass), `pnpm typecheck`,
`pnpm build`. Operator visual check: `VIDEORC_METAL_COMPOSITOR=0 pnpm dev` → badge reads
**Degraded** with the strip.

## Slice 8 — Real-camera product acceptance

Run `pnpm baseline:real-source --gate` at 1080p30 / 1440p30 + a 10-min endurance run, then
the manual by-eye pass (hand-wave idle + recording, scroll text, move the camera overlay
mid-recording, clap once; confirm the file matches the preview and mouth/voice sync). Record
the outcome in a dated note under `docs/acceptance/`. Only the operator can close this.
