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
| 2 | Hardware VideoToolbox zero-copy = default recorder/stream bridge | ✅ restored for macOS default bridge output | deterministic (cargo bridge tests + stream gate) |
| 3 | "Preparing recording…" UX + copyable preflight report | ✅ done | deterministic (cargo test + typecheck) |
| 4 | Studio health badge + degraded indicator | ✅ done | deterministic (vitest + typecheck + build) |
| 5 | Developer-only synthetic camera source (selectable) | ✅ done | deterministic (cargo test + typecheck) |
| 6 | ProgramFrame contract + parity check | ✅ done | deterministic (test:scripts) |
| 7 | Visual/timing parity fixtures | ✅ done | deterministic (test:scripts) |
| 8 | Real-camera product acceptance (closes plan) | 🟡 note ready, operator pass pending | real-camera by-eye (user) |

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

## Slice 2 — Hardware VideoToolbox zero-copy = default recorder/stream bridge ✅

The macOS stream-enabled default bridge output is now the production-shaped
VideoToolbox H.264 path. Raw-YUV is still available only as an explicit developer fallback:
`VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT=raw-yuv420p`.

**Why this isn't a blind one-liner:** in any VideoToolbox mode the compositor sets
`publish_yuv_frames: false` (`recording.rs:506`) and publishes Metal-target-only frames.
The GPU compositor falls back to CPU for **uncached image sources** (the Screens overlay
library is a shipped feature). A naive default-flip could therefore starve the encoder on
image-overlay scenes and produce a broken recording — exactly the class of regression the
plan reserves for on-device validation.

**Operator gate:** `pnpm baseline:real-source --gate` and
`pnpm baseline:stream:av-sync -- --gate` pass with
`encode backend = hardware-videotoolbox`, `zero-copy > 0`, `raw/Metal copied = 0`, startup
PASS, final-file PASS, encoder speed ≥ 0.98×; plus a by-eye smooth 60s playback that
includes an image-overlay scene.

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

## Slice 7 — Visual/timing parity fixtures ✅

`scripts/lib/visual-parity.mjs` builds on the slice-5 synthetic source (whose frames carry a
decodable frame-number strip) to provide the deterministic core of the parity fixtures:

- `decodeSyntheticFrameNumber` — JS mirror of the Rust strip decoder, so a fixture can read the
  frame number back from an extracted recording frame.
- `evaluateFrameSequenceParity` — **timing parity**: the recorded frame-number sequence must be
  monotonic and continuous (gaps = dropped frames, repeats = freezes, backward jumps = out of
  order), wrapping cleanly at 2^16.
- `compareFramesWithinTolerance` — **visual parity**: a preview screenshot and the decoded
  recording frame from the same program-frame window must match within a mean/max abs-diff
  tolerance that absorbs H.264/scaling noise.

The pure functions are the verifiable core (13 tests, `pnpm test:scripts` → 130 pass). The
remaining visual stimuli (text grid, color bars, cursor/hand motion, clap) and the
screenshot-vs-decoded extraction are **operator/on-device** steps — they need the running app
and a real present — and fold into the Slice 8 acceptance pass.

## Slice 6 — ProgramFrame contract + preview↔recording parity check ✅

**Contract already present:** each composited frame's `CompositorFrameEvidence`
(`crates/videorc-backend/src/compositor.rs`) already carries the per-frame identity the plan
asks for — frame id (`sequence`), scene revision, source frame ids (camera/screen sequences),
compositor timestamp (`published_at`), and output size; session-constants (fps, color profile,
encode/compositor backend) live in `DiagnosticStats`. The shared compositor structurally
guarantees preview and recording consume the *same* program frames, so a redundant unified
struct was not worth churning the recording hot path.

**New: the parity check.** `scripts/lib/preview-recording-parity.mjs` formalizes the plan's
acceptance — `evaluatePreviewRecordingParity` / `summarizePreviewRecordingParity` fail when the
preview is *consistently* behind the composited frame the recording encodes (a one-off spike is
tolerated; a majority over the frame-lag budget is not) or when preview and recording reference
different scene revisions. It reads already-exposed diagnostics (`previewCompositorFrameLag`,
`activeSceneRevision`, presented scene revision) — recording encodes the *latest* composited
frame, so preview lag behind that frame is exactly its lag behind what's being encoded. No
hot-path churn.

Verified: `pnpm test:scripts` (118 pass incl. 8 new parity cases), auto-wired via the
`scripts/lib/*.test.mjs` glob.

**Editor drafts and chrome are preview-tick state, never recorded (plan 058).**
The Scene editor's in-flight ghost rect and selection chrome reach the compositor as an
*editor draft* (`scene.editor.draft.set` / `.clear`) and are applied only in
`publish_compositor_frame` on the native-preview run without an auxiliary output
(`editor_draft_applies`), right after the scene-transition snapshot. The committed scene and
its revision are untouched: release still commits once through `scene.source.transform.update`,
and the draft drops the moment that revision installs, so the frame the recording would encode
and the frame the preview shows are identical again at commit time. A draft is refused while a
session is active and expires 2 s after its last refresh, so parity holds for every recorded or
streamed frame by construction; the live-canvas smoke (`pnpm smoke:freeform-editor`) asserts the
refusal during a real recording.

## Slice 5 — Developer-only synthetic diagnostic source ✅

A new `crates/videorc-backend/src/synthetic_diagnostic.rs` module draws, over the existing
animated test pattern, a **machine-decodable frame-number strip** (16-bit, MSB-first cells big
enough to survive scaling + H.264) plus a human-readable **frame number** and **HH:MM:SS:FF
timecode** (3×5 bitmap font). `synthetic_test_pattern_bgra` calls it, so both the Metal and CPU
composite paths get the markers, and `decode_sequence` reads the frame number back — giving a
deterministic way to match a decoded recording frame to the exact source frame (the basis for
the Slice 6/7 parity checks). The Sources tab gains a **dev-only** (`import.meta.env.DEV`)
toggle that selects this source (`sources.testPattern`).

Verified: `cargo test -p videorc-backend` (synthetic round-trip/timecode/render tests + full
suite), `cargo clippy -D warnings`, desktop `typecheck` + `vitest` + `build`. The frame number
is authoritative; the timecode is rendered at a fixed 30fps reference for readability.

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

## Slice 8 — Real-camera product acceptance 🟡

The dated acceptance note is prepared with the full operator procedure — automated metric
gates (`pnpm baseline:real-source --gate` at 1080p30 / 1440p30 + 10-min endurance) and the
by-eye checklist (hand-wave idle + recording, scroll text, preflight block, health badge,
layout move, clap) — plus the agent-run deterministic evidence (cargo 469, desktop 40,
test:scripts 130, clippy clean, typecheck/build clean):
[`docs/acceptance/2026-06-07-smooth-preview-correct-recording-acceptance.md`](acceptance/2026-06-07-smooth-preview-correct-recording-acceptance.md).

The agent does not autonomously launch the app / trigger capture permissions, so the
real-camera run and by-eye sign-off are the operator's. **Only the operator can close this.**
