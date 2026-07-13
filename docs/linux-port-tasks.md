# Linux Port Tasks

> **For agentic workers:** REQUIRED SUB-SKILL: use `compose:tdd` for every
> behavior change and `compose:execute` to run approved slices with checkpoints.
> Check a box only after the named evidence exists.

**Goal:** Implement the approved Linux architecture in dependency order while
keeping macOS and Windows green.

**Architecture:** Linux adds portal, PipeWire, preview, and encoder adapters to
the existing Rust media backend. A deterministic policy selects adapters from
simple presets or validated expert settings and reports every fallback.

**Tech stack:** Rust 2024, Tokio, XDG Desktop Portal over D-Bus, PipeWire/SPA,
FFmpeg/FFprobe, VA-API/DRM, Electron 39, React 19, TypeScript 5.9,
electron-builder, Vitest, Node test runner, GitHub Actions.

**Specification:** `docs/linux-architecture.md`

**Delivery plan:** `docs/linux-port-plan.md`

---

## [T1] Execution protocol

**Covers:** S3, S18, S19, S20

Every task uses this sequence:

- [ ] Read the task, its `Covers` sections, and every named file before editing.
- [ ] Write one minimal behavior test.
- [ ] Run the focused command and confirm the test fails for the missing behavior,
  not because of a typo, missing dependency, or broken fixture.
- [ ] Add the smallest production change that makes the test pass.
- [ ] Run the focused test and confirm clean output.
- [ ] Refactor only while the focused and neighboring tests stay green.
- [ ] Run the task gate.
- [ ] Update the relevant docs/status/evidence.
- [ ] Review the diff for secrets, generated media, unrelated files, silent
  fallbacks, and platform regressions.
- [ ] Commit only the task files with a focused conventional commit.

Configuration-only workflow/package steps still require executable validation
tests before production configuration is written. Real-device behavior adds a
dated acceptance run after automated tests; it does not replace TDD.

## [T2] Slice 0 - Linux acceptance contract and evidence layout

**Covers:** S1, S2, S12, S17, S18

**User benefit:** The owner gets an honest checklist showing what the downloaded
package can actually do on the target laptop.

**Files:**

- Create: `docs/acceptance/linux-app-acceptance-template.md`
- Create: `scripts/lib/linux-acceptance-gate.mjs`
- Create: `scripts/lib/linux-acceptance-gate.test.mjs`
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] RED: add a Node test that rejects an acceptance manifest missing GNOME
  Wayland, portal, PipeWire, capture, preview, encoder, final-artifact, A/V,
  process-cleanup, and redaction evidence.
- [ ] Verify RED:

  ```bash
  node --test scripts/lib/linux-acceptance-gate.test.mjs
  ```

  Expected: fail because `linux-acceptance-gate.mjs` does not exist.
- [ ] GREEN: implement the pure manifest validator and format its failures as
  one actionable line per missing proof.
- [ ] Add the dated template with exact commands, artifact paths, manual checks,
  and rollback recording fields.
- [ ] Ignore `docs/acceptance/artifacts/linux/` explicitly even though its parent
  is already ignored, documenting the intended evidence location.
- [ ] Add
  `pnpm acceptance:linux:verify -- /tmp/videorc-linux-acceptance/manifest.json`.
- [ ] Verify GREEN and task gate:

  ```bash
  node --test scripts/lib/linux-acceptance-gate.test.mjs
  pnpm check:text-files
  ```

## [T3] Slice 1 - Shared settings and capability protocol

**Covers:** S5, S10, S11, S12, S14

**User benefit:** Settings cannot disappear, change meaning, or silently select a
different backend while crossing Electron and Rust.

**Files:**

- Create: `crates/videorc-backend/src/media_policy/mod.rs`
- Create: `crates/videorc-backend/src/media_policy/settings.rs`
- Create: `crates/videorc-backend/src/media_policy/selection.rs`
- Create: `crates/videorc-backend/src/media_policy/fallback.rs`
- Modify: `crates/videorc-backend/src/lib.rs`
- Modify: `crates/videorc-backend/src/protocol.rs`
- Modify: `apps/desktop/src/shared/backend.ts`
- Modify: `apps/desktop/src/shared/backend-rpc-contract.ts`
- Modify: `apps/desktop/src/shared/backend-rpc-contract.test.ts`
- Modify: `apps/desktop/src/shared/protocol-contract-fixtures.test.ts`
- Modify: `protocol-fixtures/high-risk-contracts.json`

- [ ] RED: add fixtures for every preset, capture/audio/compositor/preview/encoder
  ID, fallback mode, explicit device selection, capability verdict, fingerprint,
  benchmark recommendation, and observed runtime path.
- [ ] Verify RED:

  ```bash
  pnpm --filter @videorc/desktop test -- src/shared/protocol-contract-fixtures.test.ts
  cargo test -p videorc-backend protocol
  ```

  Expected: TypeScript reports missing Linux media types and Rust rejects unknown
  fixture fields.
- [ ] GREEN: add matching Rust/TypeScript types, conservative defaults, strict
  schema bounds, and unknown-enum normalization to `automatic` with a diagnostic.
- [ ] Add table-driven Rust tests proving valid settings, rejected invalid device
  paths/rates/queue sizes, and intent/observation separation.
- [ ] Verify GREEN and task gate:

  ```bash
  cargo test -p videorc-backend media_policy protocol
  pnpm --filter @videorc/desktop test -- src/shared/backend-rpc-contract.test.ts src/shared/protocol-contract-fixtures.test.ts
  pnpm typecheck
  ```

## [T4] Slice 2 - Redacted Linux host probe

**Covers:** S2, S11, S12, S15

**User benefit:** “Test my hardware” starts from facts about this PC and explains
missing services without asking the owner to understand terminal output.

**Files:**

- Create: `crates/videorc-backend/src/linux/mod.rs`
- Create: `crates/videorc-backend/src/linux/platform_probe.rs`
- Create: `scripts/lib/linux-hardware-report.mjs`
- Create: `scripts/lib/linux-hardware-report.test.mjs`
- Modify: `crates/videorc-backend/src/lib.rs`
- Modify: `crates/videorc-backend/src/main.rs`
- Modify: `crates/videorc-backend/src/protocol.rs`
- Modify: `apps/desktop/src/shared/backend.ts`
- Modify: `apps/desktop/src/shared/backend-rpc-contract.ts`

- [ ] RED: test a synthetic PikaOS/Haswell host and assert the report includes
  distro/session/service/GPU/DRM/VA/FFmpeg facts but removes username, home path,
  environment secrets, portal tokens, and device serials.
- [ ] Verify RED:

  ```bash
  node --test scripts/lib/linux-hardware-report.test.mjs
  cargo test -p videorc-backend linux::platform_probe
  ```

  Expected: fail because the probe and redactor are absent.
- [ ] GREEN: implement injectable filesystem/command readers, structured
  capability failures, hardware fingerprinting, and RPC exposure.
- [ ] Add intent comments explaining why `/sys` observation and `/dev` openability
  are separate facts and why an encoder listing is not proof.
- [ ] Verify GREEN and task gate:

  ```bash
  cargo test -p videorc-backend linux::platform_probe
  node --test scripts/lib/linux-hardware-report.test.mjs
  pnpm --filter @videorc/desktop test -- src/shared/backend-rpc-contract.test.ts
  ```

## [T5] Slice 3 - Linux package skeleton and lifecycle

**Covers:** S13, S15, S16

**User benefit:** GitHub produces an installable app that launches and closes
cleanly without requiring Rust, Node, or pnpm on the laptop.

**Files:**

- Create: `scripts/preflight-linux-package.mjs`
- Create: `scripts/lib/linux-package-preflight.mjs`
- Create: `scripts/lib/linux-package-preflight.test.mjs`
- Create: `scripts/smoke-packaged-linux-health.mjs`
- Modify: `apps/desktop/electron-builder.yml`
- Modify: `apps/desktop/package.json`
- Modify: `package.json`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/backend-owned-processes.ts`
- Modify: corresponding Electron main tests

- [ ] RED: test that preflight rejects a missing backend, FFmpeg, FFprobe, license,
  build configuration, wrong architecture, or executable bit.
- [ ] Verify RED:

  ```bash
  node --test scripts/lib/linux-package-preflight.test.mjs
  ```

  Expected: fail because Linux package preflight does not exist.
- [ ] GREEN: implement package preflight and Electron Builder `deb` resources,
  icons, desktop/protocol metadata, and amd64 artifact naming.
- [ ] Add `package:preflight:linux`, `package:desktop:linux`,
  `dist:desktop:linux`, and `smoke:packaged:linux:health` scripts.
- [ ] Add Linux process-tree tests proving only ledger-owned PIDs receive TERM,
  grace, then KILL and that clean exit removes the ledger entry.
- [ ] Task gate, run in GitHub rather than routinely on the target PC:

  ```bash
  pnpm test:scripts
  pnpm --filter @videorc/desktop test
  pnpm package:preflight:linux
  pnpm dist:desktop:linux
  pnpm smoke:packaged:linux:health
  ```

## [T6] Slice 4 - XDG portal state machine

**Covers:** S4, S6, S11, S15

**User benefit:** GNOME shows the trusted system screen/window picker and access
ends when Videorc stops capturing.

**Files:**

- Create: `crates/videorc-backend/src/linux/portal.rs`
- Create: `apps/desktop/src/main/linux/portal-parent.ts`
- Create: `apps/desktop/src/main/linux/portal-parent.test.ts`
- Modify: `crates/videorc-backend/src/linux/mod.rs`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: shared protocol/RPC files

- [ ] RED: add Rust state-machine tests for create, select, start, open remote,
  cancel, portal-close, invalid restore token, and explicit shutdown.
- [ ] RED: add Electron tests for a valid Wayland parent identifier and graceful
  absence when the compositor/runtime cannot provide one.
- [ ] Verify RED:

  ```bash
  cargo test -p videorc-backend linux::portal
  pnpm --filter @videorc/desktop test -- src/main/linux/portal-parent.test.ts
  ```

  Expected: fail because portal modules are absent.
- [ ] GREEN: implement one owner for each portal request/session, FD transfer,
  stable stream serial parsing, redacted restore-token storage, and cancellation.
- [ ] Comment the single-use restore-token behavior, FD ownership boundary, and
  why numeric PipeWire node IDs cannot be persisted.
- [ ] Task gate:

  ```bash
  cargo test -p videorc-backend linux::portal
  pnpm --filter @videorc/desktop test -- src/main/linux/portal-parent.test.ts
  cargo clippy -p videorc-backend -- -D warnings
  ```

## [T7] Slice 5 - PipeWire core and bounded video frames

**Covers:** S3, S4, S5, S6

**User benefit:** Screen frames arrive with low latency instead of building an
ever-growing queue that makes preview fall seconds behind.

**Files:**

- Create: `crates/videorc-backend/src/linux/pipewire.rs`
- Modify: `crates/videorc-backend/Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `crates/videorc-backend/src/linux/mod.rs`
- Modify: shared compositor/frame-store modules

- [ ] RED: test format negotiation, mapped/memfd buffer handling, stride,
  timestamp conversion, latest-wins replacement, sequence gaps, disconnect, and
  deterministic shutdown using injectable synthetic buffers.
- [ ] Verify RED:

  ```bash
  cargo test -p videorc-backend linux::pipewire
  ```

  Expected: fail because the PipeWire adapter is absent.
- [ ] GREEN: add the minimum `pipewire`/SPA dependency surface and implement the
  authorized connection received from the portal rather than opening unrestricted
  screen nodes.
- [ ] Add counters for received, replaced, malformed, late, and presented frames.
- [ ] Comment buffer lifetime and why processing must release PipeWire buffers
  promptly even when the downstream consumer is slow.
- [ ] Task gate:

  ```bash
  cargo fmt --check --all
  cargo test -p videorc-backend linux::pipewire
  cargo clippy -p videorc-backend -- -D warnings
  ```

## [T8] Slice 6 - Native screen/window capture adapter

**Covers:** S5, S6, S11, S12

**User benefit:** The selected monitor or window appears in Videorc with accurate
motion, dimensions, cursor policy, and recovery when the source disappears.

**Files:**

- Create: `crates/videorc-backend/src/linux/screen.rs`
- Modify: `screen_capture.rs`, `devices.rs`, `capture_input.rs`
- Modify: `preview_screen.rs`, `recording.rs`
- Modify: renderer source-selection helpers and tests
- Create: `scripts/smoke-linux-portal-screen.mjs`
- Create: `scripts/lib/linux-screen-gates.mjs`
- Create: `scripts/lib/linux-screen-gates.test.mjs`

- [ ] RED: add source mapping tests for monitor/window IDs, restore identity,
  cursor modes, resolution changes, portal revocation, and missing source.
- [ ] RED: add artifact-gate tests rejecting blank, constant, stale, wrong-size,
  or wrong-source frames.
- [ ] Verify RED:

  ```bash
  cargo test -p videorc-backend linux::screen capture_input
  node --test scripts/lib/linux-screen-gates.test.mjs
  ```

  Expected: fail on unsupported Linux source mapping.
- [ ] GREEN: connect portal-authorized PipeWire frames to the shared scene source
  contract and expose truthful source/device details.
- [ ] Task gate:

  ```bash
  cargo test -p videorc-backend linux::screen capture_input
  pnpm --filter @videorc/desktop test -- src/renderer/src/lib/source-select-state.test.ts
  node --test scripts/lib/linux-screen-gates.test.mjs
  pnpm smoke:linux:portal-screen
  ```

  The last command requires the real GNOME Wayland session.

## [T9] Slice 7 - Electron screen compatibility adapter

**Covers:** S5, S6, S11

**User benefit:** A second screen-capture path remains available when native
PipeWire integration fails on a future Electron/portal combination.

**Files:**

- Create: `apps/desktop/src/main/linux/electron-capture-bridge.ts`
- Create: `apps/desktop/src/main/linux/electron-capture-bridge.test.ts`
- Create: `apps/desktop/src/renderer/src/lib/electron-capture-source.ts`
- Create: corresponding renderer test
- Modify: `apps/desktop/src/main/index.ts`
- Modify: shared RPC/settings types

- [ ] RED: test session authentication, exact frame-size validation, latest-wins
  capacity, stale sequence rejection, stop/close, and fallback reason propagation.
- [ ] Verify RED:

  ```bash
  pnpm --filter @videorc/desktop test -- src/main/linux/electron-capture-bridge.test.ts src/renderer/src/lib/electron-capture-source.test.ts
  ```

  Expected: fail because the compatibility bridge is absent.
- [ ] GREEN: implement a bounded binary/shared-memory bridge; reject JSON arrays,
  PNG/JPEG polling, and unbounded `postMessage` accumulation for production.
- [ ] Task gate:

  ```bash
  pnpm --filter @videorc/desktop test -- src/main/linux/electron-capture-bridge.test.ts src/renderer/src/lib/electron-capture-source.test.ts
  pnpm typecheck
  pnpm lint
  ```

## [T10] Slice 8 - Camera adapters

**Covers:** S5, S7, S11

**User benefit:** The laptop webcam works through the best available Linux path,
with V4L2/FFmpeg available as an understandable fallback.

**Files:**

- Create: `crates/videorc-backend/src/linux/camera.rs`
- Modify: `camera_capture.rs`, `devices.rs`, `capture_input.rs`
- Modify: `preview_camera.rs`, `recording.rs`
- Modify: camera format UI helpers/tests
- Create: `scripts/smoke-linux-camera.mjs`

- [ ] RED: test PipeWire and V4L2 device normalization, stable logical identity,
  format ranking, explicit device selection, hotplug, unavailable device, and
  generated FFmpeg V4L2 arguments.
- [ ] Verify RED:

  ```bash
  cargo test -p videorc-backend linux::camera camera_capture capture_input
  ```

  Expected: fail because Linux camera discovery currently reports unsupported.
- [ ] GREEN: implement PipeWire primary plus V4L2/FFmpeg compatibility adapters
  behind one camera contract.
- [ ] Task gate:

  ```bash
  cargo test -p videorc-backend linux::camera camera_capture capture_input
  pnpm --filter @videorc/desktop test -- src/renderer/src/lib/camera-format-shortfall.test.ts
  pnpm smoke:linux:camera
  ```

## [T11] Slice 9 - Microphone and system-audio adapters

**Covers:** S5, S7, S11, S17

**User benefit:** Voice and computer audio record together with meters, gain/mute,
and analyzer-proven synchronization.

**Files:**

- Create: `crates/videorc-backend/src/linux/audio.rs`
- Modify: `audio.rs`, `devices.rs`, `capture_input.rs`, `recording.rs`
- Modify: shared audio protocol types and UI helpers/tests
- Create: `scripts/smoke-linux-av-capture.mjs`
- Modify: A/V analyzer/gate tests as needed

- [ ] RED: test PipeWire microphone and monitor identity, Pulse compatibility,
  ALSA last-resort selection, gain/mute filters, default-device changes, feedback
  prevention, timestamp conversion, and explicit no-system-audio.
- [ ] Verify RED:

  ```bash
  cargo test -p videorc-backend linux::audio audio capture_input
  pnpm test:scripts
  ```

  Expected: fail because native Linux microphone discovery is unsupported.
- [ ] GREEN: implement bounded audio adapters and connect them to existing meters,
  processing settings, recording, and stream mixing.
- [ ] Comment clock-domain conversion and monitor-source feedback prevention.
- [ ] Task gate:

  ```bash
  cargo test -p videorc-backend linux::audio audio capture_input
  pnpm --filter @videorc/desktop test -- src/renderer/src/lib/mic-meter.test.ts src/renderer/src/lib/live-audio-processing.test.ts
  pnpm test:scripts
  pnpm smoke:linux:av-capture
  ```

## [T12] Slice 10 - Encoder probes and selection policy

**Covers:** S9, S10, S11, S12

**User benefit:** Videorc chooses an encoder proven to work on the Intel GPU and
can fall back without hiding the increased CPU cost.

**Files:**

- Create: `crates/videorc-backend/src/linux/vaapi.rs`
- Modify: media-policy modules
- Modify: `recording.rs`, `encoder_bridge.rs`, diagnostics protocol
- Create: `scripts/lib/linux-ffmpeg-capabilities.mjs`
- Create: `scripts/lib/linux-ffmpeg-capabilities.test.mjs`
- Create: `scripts/probe-linux-hardware.mjs`

- [ ] RED: table-test candidate ranking for the target Haswell host across all
  presets, strict/ask/automatic/software-only/hardware-only fallback modes, dual
  output, failed artifact probes, and stale fingerprints.
- [ ] RED: test FFmpeg probe analysis rejecting encoder-list-only success, blank
  output, wrong dimensions, wrong codec, timing failure, and nonzero process exit.
- [ ] Verify RED:

  ```bash
  cargo test -p videorc-backend media_policy linux::vaapi
  node --test scripts/lib/linux-ffmpeg-capabilities.test.mjs
  ```

  Expected: fail because selection and artifact probing are absent.
- [ ] GREEN: implement DRM/VA discovery, bounded synthetic encode/decode proof,
  candidate ranking, fingerprint cache, and structured fallback decisions.
- [ ] Task gate:

  ```bash
  cargo test -p videorc-backend media_policy linux::vaapi
  node --test scripts/lib/linux-ffmpeg-capabilities.test.mjs
  pnpm probe:linux-hardware -- --quick
  ```

## [T13] Slice 11 - Presets and Advanced settings UI

**Covers:** S10, S11, S12, S14

**User benefit:** The owner can use a one-click recommendation or inspect and pin
every meaningful media choice without editing environment variables.

**Files:**

- Create: `apps/desktop/src/renderer/src/lib/linux-media-settings.ts`
- Create: `apps/desktop/src/renderer/src/lib/linux-media-settings.test.ts`
- Create: `apps/desktop/src/renderer/src/components/settings/linux-media-settings.tsx`
- Create: component test
- Modify: `settings-tab.tsx`, `quick-settings.tsx`
- Modify: Studio provider/session-param helpers and tests
- Modify: shared protocol/RPC files

- [ ] RED: test preset summaries, capability filtering, unavailable reasons,
  Custom-mode validation, separate recording/stream encoder choices, fallback
  policy, reset to recommendation, and persistence of intent.
- [ ] RED: test “Test my hardware” staged progress, cancellation, prior known-good
  preservation, plain-language result, and expert report disclosure.
- [ ] Verify RED:

  ```bash
  pnpm --filter @videorc/desktop test -- src/renderer/src/lib/linux-media-settings.test.ts src/renderer/src/components/settings/linux-media-settings.test.tsx
  ```

  Expected: fail because Linux settings components are absent.
- [ ] GREEN: implement Automatic, Performance, Balanced, Quality, Compatibility,
  and Custom plus capability-filtered Advanced sections.
- [ ] Keep driver/device overrides under Advanced and attach benefit/impact copy to
  every choice; show requested, selected, and fallback state during sessions.
- [ ] Task gate:

  ```bash
  pnpm --filter @videorc/desktop test
  pnpm typecheck
  pnpm lint
  pnpm format:check
  ```

## [T14] Slice 12 - Linux composition and preview adapters

**Covers:** S4, S8, S11, S17

**User benefit:** Layout changes stay smooth and preview continues while recording,
with native GPU and compatibility choices clearly identified.

**Files:**

- Extend: `compositor.rs`, `preview_surface.rs`, `native_preview_host.rs`
- Create: Linux preview helper modules/binary under the backend crate
- Create: `apps/desktop/src/main/linux/preview-helper.ts`
- Create: matching Electron main tests
- Modify: preview supervisor/policy/lifecycle helpers and tests
- Create: `scripts/smoke-linux-preview.mjs`
- Create: `scripts/lib/linux-preview-gates.mjs`
- Create: `scripts/lib/linux-preview-gates.test.mjs`

- [ ] RED: test CPU reference pixels and scene revisions for all layouts.
- [ ] RED: test native-wgpu capability failure, Electron-WebGL fallback, strict
  selection, latest-wins frames, resize, visibility, close/reopen, helper crash,
  focus continuity, and teardown.
- [ ] Verify RED:

  ```bash
  cargo test -p videorc-backend compositor preview_surface native_preview_host
  pnpm --filter @videorc/desktop test -- src/main/preview-supervisor.test.ts
  node --test scripts/lib/linux-preview-gates.test.mjs
  ```

  Expected: fail because no Linux production preview path exists.
- [ ] GREEN: implement CPU correctness baseline, native `winit`/`wgpu` helper,
  Electron WebGL compatibility, and explicit MJPEG debug-only labeling.
- [ ] Add `wgpu` composition only in a separate red-green cycle after CPU parity.
- [ ] Task gate:

  ```bash
  cargo test -p videorc-backend compositor preview_surface native_preview_host
  pnpm --filter @videorc/desktop test
  node --test scripts/lib/linux-preview-gates.test.mjs
  pnpm probe:preview-lifecycle
  pnpm smoke:linux:preview
  pnpm smoke:linux:all-layouts
  ```

## [T15] Slice 13 - Recording and streaming artifact parity

**Covers:** S1, S4, S9, S17

**User benefit:** Finished recordings and streams—not just preview—contain the
correct moving picture, overlays, microphone, and computer audio.

**Files:**

- Modify: `recording.rs`, `streaming.rs`, `encoder_bridge.rs`, `fifo.rs`
- Modify: recording/stream diagnostics protocol mirrors
- Create: `scripts/smoke-recording-studio-linux.mjs`
- Create: Linux performance/gate modules and tests
- Modify: `scripts/smoke-recording-studio.mjs`
- Modify: `package.json`

- [ ] RED: add final-artifact gates for every layout and source combination,
  expected dimensions/FPS/duration, visible motion, non-silent audio, A/V skew,
  correct encoder tag, preview liveness, and separate record/stream profiles.
- [ ] Verify RED:

  ```bash
  pnpm test:scripts
  cargo test -p videorc-backend recording streaming encoder_bridge fifo
  ```

  Expected: Linux session construction or artifact expectations fail.
- [ ] GREEN: wire Linux sources and selected encoders through existing recording
  and streaming ownership without adding an unbounded raw-frame path.
- [ ] Add `smoke:recording-studio:linux-devices` and include it in the maintained
  recording-studio matrix without changing macOS device invocation.
- [ ] Task gate:

  ```bash
  pnpm test:scripts
  cargo test -p videorc-backend
  cargo clippy -p videorc-backend -- -D warnings
  pnpm smoke:recording-studio
  pnpm smoke:recording-studio:linux-devices
  ```

## [T16] Slice 14 - Full feature audit

**Covers:** S1, S12, S15, S17

**User benefit:** Linux is a complete Videorc build rather than a recorder with
missing library, publishing, AI, captions, or maintenance tools.

**Files:**

- Audit and modify platform gates in backend and renderer feature modules
- Modify Linux permission, shortcut, health, and diagnostics copy
- Extend support-bundle verifier and tests
- Create: `scripts/lib/linux-feature-parity.mjs`
- Create: `scripts/lib/linux-feature-parity.test.mjs`
- Create: `scripts/smoke-linux-full-parity.mjs`

- [ ] RED: create a maintained feature manifest covering capture, layouts,
  overlays, recording, streaming, imports, repair, clips, publishing, Noise
  Cleanup, captions, comments, AI workflows, updates, diagnostics, and support
  bundles; reject unclassified features.
- [ ] Verify RED:

  ```bash
  node --test scripts/lib/linux-feature-parity.test.mjs
  ```

  Expected: fail with the current unsupported/unclassified Linux paths.
- [ ] GREEN: implement applicable platform behavior or an explicit capability
  blocker and recovery action for every manifest row.
- [ ] Task gate:

  ```bash
  pnpm test:scripts
  pnpm --filter @videorc/desktop test
  cargo test -p videorc-backend
  pnpm smoke:linux:full-parity
  ```

## [T17] Slice 15 - On-device performance calibration

**Covers:** S2, S8, S9, S12, S17

**User benefit:** Defaults are based on measured behavior of this laptop, avoiding
settings that cause lag, heat, or unusable recordings.

**Files:**

- Add Linux scenarios to performance runner and its tests
- Add active/candidate Linux budget files under `config/performance-budgets/v1/`
- Create: `scripts/smoke-local-gates-linux.mjs`
- Create: `scripts/lib/linux-local-gates.mjs`
- Create: `scripts/lib/linux-local-gates.test.mjs`
- Modify: `package.json`

- [ ] RED: test that the Performance preset gate rejects low presented FPS, high
  latency, dropped/repeated bursts, A/V skew, unbounded memory, CPU starvation,
  and orphaned children.
- [ ] Verify RED:

  ```bash
  node --test scripts/lib/linux-local-gates.test.mjs scripts/lib/performance-scenarios.test.mjs
  ```

  Expected: fail because Linux scenarios and budgets do not exist.
- [ ] GREEN: add quick, five-minute, and 30-minute 720p30 scenarios plus optional
  1080p30 candidate scenarios and recommendation output.
- [ ] On the target PC run:

  ```bash
  pnpm perf:scenario --scenario linux-720p30 --gate
  pnpm perf:scenario --scenario linux-preview-recording --gate
  pnpm perf:scenario --scenario linux-720p30-endurance --gate
  ```

- [ ] Promote a candidate budget only after three representative successful runs;
  keep raw evidence ignored and record the summarized result in a dated note.

## [T18] Slice 16 - PR preview and main Linux workflows

**Covers:** S16

**User benefit:** GitHub builds every preview and main package; the laptop only
downloads the result.

**Files:**

- Create: `.github/workflows/linux.yml`
- Create: `scripts/build-linux-build-info.mjs`
- Create: `scripts/lib/linux-build-info.mjs`
- Create: `scripts/lib/linux-build-info.test.mjs`
- Create: `scripts/validate-linux-artifacts.mjs`
- Create: validation module/tests

- [ ] RED: test build metadata, artifact naming, checksums, required capability
  manifest fields, and rejection of mismatched commit/version/architecture.
- [ ] Verify RED:

  ```bash
  node --test scripts/lib/linux-build-info.test.mjs scripts/lib/linux-release-artifacts.test.mjs
  ```

  Expected: fail because build/release artifact helpers are absent.
- [ ] GREEN: add Linux Rust/JS gates, package job dependencies, cached toolchains,
  PR artifact upload, main prerelease publication, concurrency, least permissions,
  and fork-PR secret isolation.
- [ ] Include `.deb`, checksum, build info, capabilities, and notices in every
  artifact set; include user-facing PR/commit intent in main prerelease notes.
- [ ] Task gate:

  ```bash
  pnpm test:scripts
  pnpm check:text-files
  actionlint .github/workflows/*.yml
  ```

## [T19] Slice 17 - Upstream watcher and tagged Linux release

**Covers:** S16

**User benefit:** Changes from the original repository arrive through visible,
tested sync PRs, and approved tags create permanent Linux downloads with notes.

**Files:**

- Create: `.github/workflows/upstream-sync.yml`
- Create: `.github/workflows/release-linux.yml`
- Create: scripts/modules/tests for upstream comparison and release-note assembly
- Modify: `docs/releases/release-runbook.md`
- Modify: `docs/distribution.md`

- [ ] RED: test no-change, fast-forward, divergent, existing-sync-PR, untrusted
  fork, missing changelog, failed package, and checksum verification cases.
- [ ] Verify RED:

  ```bash
  pnpm test:scripts
  ```

  Expected: fail because Linux sync/release helpers do not exist.
- [ ] GREEN: schedule upstream comparison, open/update one sync PR, run normal PR
  gates, and require review/checks before fork-main changes.
- [ ] GREEN: on `v*`, build or consume a commit-matched validated package and
  publish an immutable GitHub Release with changelog, commit/PR notes, checksums,
  provenance/build info, and explicit beta/stable channel.
- [ ] Verify the created release through GitHub and download/checksum the `.deb`;
  do not infer success from a tag push.

## [T20] Slice 18 - Clean install, update, rollback, and handoff

**Covers:** S1, S12, S16, S17, S18

**User benefit:** The exact GitHub artifact installs and updates on the owner's PC,
and there is a safe path back to the previous package.

**Files:**

- Copy and complete: `docs/acceptance/linux-app-acceptance-template.md`
- Update: `docs/linux-port-plan.md`
- Update: `docs/linux-port-tasks.md`
- Update: `docs/distribution.md`
- Create for the selected release ID: the matching `changelog/*.md` entry and
  `docs/releases/*.md` engineering record, following the existing release naming
  convention

- [ ] Download the GitHub artifact and verify its SHA-256 before installation.
- [ ] Install with the documented Debian package command and record the actual
  package/version query output.
- [ ] Run packaged health, hardware, device, preview, recording-studio, streaming,
  full-parity, process, and support-bundle gates.
- [ ] Install the next preview/main build without local compilation and verify
  settings, projects, recordings, database, and explicit backend selections.
- [ ] Roll back to the previous known-good `.deb` and verify user recordings remain.
- [ ] Confirm the GitHub run and release page expose downloadable artifacts.
- [ ] Mark Linux v1 complete only after every Definition of Done item in
  `docs/linux-port-plan.md` has current evidence.

## [T21] Required final verification matrix

Before the final Linux release handoff, run or obtain fresh CI evidence for:

```bash
pnpm audit:deps
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @videorc/desktop test
pnpm test:scripts
cargo fmt --check --all
cargo test -p videorc-backend
cargo clippy -p videorc-backend -- -D warnings
pnpm smoke:recording-studio
pnpm smoke:recording-studio:linux-devices
pnpm smoke:local-gates:linux
pnpm release:validate:linux
```

CI is authoritative for expensive clean compilation and packaging. The target
host is authoritative for GNOME Wayland consent, real devices, VA-API behavior,
preview smoothness, final artifacts, and endurance. A release requires both.
