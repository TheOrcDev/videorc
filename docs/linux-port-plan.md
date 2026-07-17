# Linux Port Plan

Status: master delivery plan

Specification: `docs/linux-architecture.md`

Initial acceptance host: Dell Latitude E7240, PikaOS 4, GNOME Wayland, amd64

## [P1] Goal

Deliver a complete, performant Videorc `.deb` for the owner's Linux PC while
moving compilation and packaging to GitHub Actions. The product must provide
simple presets, extensive capability-filtered advanced settings, truthful
fallbacks, PR preview packages, main-branch prereleases, and immutable tagged
releases with useful change intent.

The work is documentation-driven and test-driven. Each phase begins with a
focused implementation plan derived from this master plan and
`docs/linux-port-tasks.md`. Production behavior is added only after a new test
has failed for the expected reason.

## [P2] Definition of done

Linux v1 is done only when all of the following are true on the initial host:

- the `.deb` installs, launches, updates, and uninstalls cleanly;
- screen and window sources can be selected through the GNOME Wayland portal;
- webcam, microphone, and system audio are discoverable and usable;
- all maintained scene layouts and overlays remain live in preview and output;
- 720p30 recording clears final-artifact motion, duration, and A/V gates;
- a simultaneous preview and recording session remains responsive;
- a supported livestream target passes a real end-to-end smoke;
- imports, clips, Noise Cleanup, and existing AI/media workflows pass their
  applicable Linux gates;
- Automatic, Performance, Balanced, Quality, Compatibility, and Custom settings
  behave as documented;
- each runtime reports requested, selected, and observed media implementations;
- no silent fallback or orphaned Videorc-owned process remains;
- pull requests and main builds expose downloadable validated `.deb` artifacts;
- a tagged workflow creates a GitHub Release containing notes, checksums, build
  metadata, and the exact commit;
- architecture, commands, settings examples, and acceptance evidence are current.

## [P3] Delivery rules

1. Preserve existing macOS and Windows behavior with platform-gated changes.
2. Add focused modules instead of expanding the largest orchestration files.
3. Run the smallest test that proves each red/green cycle.
4. Do not run expensive release builds on the target PC.
5. Use GitHub-hosted Linux runners for compile, package, and synthetic smokes.
6. Use the target PC only for bounded portal, device, VA-API, preview, recording,
   streaming, and endurance evidence.
7. Never treat a successful compile as capture acceptance.
8. Never treat artifact upload as release success without confirming that the
   artifact is downloadable.
9. Keep generated reports and media under ignored acceptance-artifact paths.
10. Stage and commit only files belonging to the active slice.

## [P4] Phase 0 - Freeze contracts and baseline the host

### Outcome

The Linux requirements are executable contracts before platform code is added.

### Work

- Add Rust and TypeScript types for presets, adapter IDs, capability verdicts,
  fallback modes, hardware fingerprints, benchmark results, and observed paths.
- Add protocol fixtures proving all fields survive Rust/TypeScript normalization.
- Add a read-only Linux host probe that reports distribution, session, portal,
  PipeWire, DRM, VA driver, FFmpeg, camera/audio visibility, and redaction status.
- Add a dated Linux acceptance template and ignored evidence directory contract.
- Capture the initial host baseline without encoding a long recording.

### Gates

```bash
cargo test -p videorc-backend protocol
pnpm --filter @videorc/desktop test
pnpm test:scripts
pnpm check:text-files
```

### Stop conditions

- Rust/TypeScript protocol values do not round-trip exactly.
- The probe exposes usernames, tokens, portal restore tokens, or private paths.
- The host has no working GNOME portal or PipeWire service outside the agent
  sandbox; record the environmental blocker before capture implementation.

## [P5] Phase 1 - Linux launch, paths, ownership, and package skeleton

### Outcome

A GitHub-built development `.deb` launches the Electron app, starts the backend,
connects over the existing authenticated loopback transport, and shuts down
without leaving children. Capture may still report unavailable in this phase.

### Work

- Add Linux paths and permission copy without changing macOS/Windows behavior.
- Verify FIFO, Unix signal, OAuth callback, protocol registration, and owned PID
  behavior on Linux.
- Add Electron Builder `linux.deb` configuration and a fail-closed package
  preflight.
- Define a pinned Linux FFmpeg bundle with version, license, source, and build
  configuration evidence.
- Add an Ubuntu GitHub job that builds and opens the unpacked/package skeleton
  with a synthetic backend health probe.

### Gates

```bash
cargo test -p videorc-backend storage process_job fifo
pnpm --filter @videorc/desktop test
pnpm package:preflight:linux
pnpm dist:desktop:linux
pnpm smoke:packaged:linux:health
```

The two packaging commands run in GitHub Actions for routine work. On the target
PC, only installation and the packaged health smoke are required.

### Stop conditions

- Package preflight cannot prove backend and FFmpeg/FFprobe resources.
- App shutdown leaves a ledger-recorded backend, preview helper, or FFmpeg PID.
- The package requires development tools at runtime.

## [P6] Phase 2 - Portal and native PipeWire screen/window capture

### Outcome

The user selects a monitor or window through the GNOME Wayland picker, Videorc
receives live frames in the backend, and revoking/closing the portal session
stops capture cleanly.

### Work

- Implement the portal create/select/start/open/close state machine.
- Attach the portal request to the Electron window using a valid Wayland parent
  identifier when supported.
- Connect the returned PipeWire remote FD and target the authorized stream.
- Negotiate supported raw video formats and normalize them into the shared scene
  frame contract.
- Persist restore tokens only when enabled, redact them everywhere, and recover
  from an invalid single-use token by showing the source picker.
- Implement latest-wins bounded buffering and capture clock diagnostics.
- Implement the Electron compatibility adapter behind the same frame contract.

### Gates

```bash
cargo test -p videorc-backend linux::portal
cargo test -p videorc-backend linux::pipewire
cargo test -p videorc-backend linux::screen
pnpm --filter @videorc/desktop test
pnpm smoke:linux:portal-screen
```

The final smoke runs on the real GNOME Wayland host. CI uses deterministic portal
contract doubles and a synthetic PipeWire node; it does not claim real portal
acceptance.

### Stop conditions

- Frame permissions outlive the portal session.
- Source identity relies only on a reusable numeric PipeWire node ID.
- The compatibility bridge uses unbounded queues or compressed-image polling as
  a production transport.

## [P7] Phase 3 - Camera, microphone, and system audio

### Outcome

Videorc discovers and captures the owner's webcam, microphone, and desktop audio,
including hotplug/default-device changes and visible fallback status.

### Work

- Add PipeWire camera format discovery and frame capture.
- Add V4L2/FFmpeg camera compatibility with capability-filtered devices.
- Add PipeWire microphone capture, gain/mute, meters, and format normalization.
- Add PipeWire output-monitor system-audio capture.
- Add PulseAudio and ALSA compatibility adapters where detected.
- Reconcile capture clocks into the existing A/V timing model.
- Add explicit permission/device-missing errors and recovery actions.

### Gates

```bash
cargo test -p videorc-backend linux::camera
cargo test -p videorc-backend linux::audio
cargo test -p videorc-backend capture_input
pnpm test:scripts
pnpm smoke:linux:devices
pnpm smoke:linux:av-capture
```

### Stop conditions

- Device settings persist only transient node numbers.
- Muting or changing gain changes the wrong device.
- System audio creates feedback through the selected microphone/output path.
- Final-artifact A/V analysis fails; manual playback is not a substitute.

## [P8] Phase 4 - Shared composition and Linux preview

### Outcome

Every maintained layout and overlay renders from one committed scene revision,
and preview stays live before, during, and after recording.

### Work

- Prove the cross-platform CPU compositor against existing synthetic fixtures.
- Add a Linux native detached preview helper using `winit`/`wgpu` when its
  capability probe succeeds.
- Add an Electron WebGL compatibility preview with bounded latest-wins transport.
- Keep MJPEG/image polling debug-only and label its fallback reason.
- Add preview backend settings, helper lifecycle ownership, visibility, resize,
  close/reopen, focus continuity, and compositor-controlled placement handling.
- Add optional `wgpu` composition only after pixel and scene-revision parity with
  the CPU compositor is proven.

### Gates

```bash
cargo test -p videorc-backend compositor preview_surface native_preview_host
pnpm --filter @videorc/desktop test
pnpm probe:preview-lifecycle
pnpm smoke:linux:preview
pnpm smoke:linux:all-layouts
```

`probe:preview-lifecycle` requires a Linux-aware launcher before it can become an
on-host gate. Existing macOS behavior remains covered by its current path.

### Stop conditions

- Preview and recording consume different scene revisions.
- A claimed native preview is actually image polling or a silent fallback.
- Closing/reopening preview leaks a helper, surface, or PipeWire stream.
- GPU composition differs from CPU reference pixels beyond the accepted tolerance.

## [P9] Phase 5 - Encoding policy, hardware check, and settings

### Outcome

Automatic mode selects a proven encoder and profile; Advanced settings can pin
capture, preview, composition, and encoding choices with strict or visible
fallback behavior.

### Work

- Implement VA-API DRM discovery and bounded artifact probes.
- Detect viable `h264_vaapi`, optional `h264_qsv`, `libx264`, and
  `libopenh264` choices rather than trusting encoder listings.
- Add presets, advanced controls, fallback policy, resource limits, and validation.
- Add the hardware fingerprint and invalidate recommendations after meaningful
  system/app changes.
- Add “Test my hardware,” staged recommendations, progress, cancellation, and
  plain-language plus expert reports.
- Persist intent separately from observations and benchmark results.

### Gates

```bash
cargo test -p videorc-backend media_policy linux::vaapi
pnpm --filter @videorc/desktop test
pnpm test:scripts
pnpm probe:linux-hardware -- --quick
pnpm smoke:linux:encoder-matrix
```

### Stop conditions

- Automatic selects an encoder without a successful artifact probe.
- Manual strict selection silently changes backend.
- A failed benchmark corrupts the previous known-good recommendation.
- The UI offers devices or drivers the packaged runtime cannot open.

## [P10] Phase 6 - Recording, streaming, and full feature parity

### Outcome

Linux supports the full Studio workflow with analyzer-proven recording and a real
livestream while imports, clips, Noise Cleanup, and AI/media tools remain usable.

### Work

- Route Linux sources through all layout presets and recording containers.
- Prove camera/microphone/system-audio combinations and audio processing.
- Support separate recording and stream profiles with truthful encoder diagnostics.
- Prove at least one real provider stream plus the existing fake-provider gates.
- Audit platform gates for imports, repair, clips, publishing, Noise Cleanup,
  captions, comments, AI analysis, and support bundles.
- Replace macOS-specific permission/shortcut/health copy on Linux.
- Add Linux final-artifact, process, memory, and support-bundle acceptance.

### Gates

```bash
pnpm test:scripts
pnpm --filter @videorc/desktop test
cargo test -p videorc-backend
cargo clippy -p videorc-backend -- -D warnings
pnpm smoke:recording-studio
pnpm smoke:recording-studio:linux-devices
pnpm smoke:linux:full-parity
```

The Linux recording-studio aggregator must include desktop capture/session
parameters, artifact analysis, A/V sync, all layouts, real screen recording,
preview liveness, lifecycle, process ownership, and bundled package execution.

### Stop conditions

- Any core feature is hidden rather than implemented or explicitly explained.
- A recording smoke checks only file existence or size.
- The real provider stream cannot distinguish provider eligibility from code failure.
- Support bundles expose private media, tokens, or portal credentials.

## [P11] Phase 7 - Performance tuning on the initial host

### Outcome

The Performance preset sustains 720p30 on the Latitude E7240 without making the
desktop unusable. Quality mode advertises 1080p30 only if it passes.

### Work

- Measure capture, composition, preview, encode, and mux stages separately.
- Remove avoidable full-frame copies before changing quality defaults.
- Calibrate queue capacity and latest-wins behavior.
- Compare VA-API with software fallback using final artifacts, CPU, latency,
  temperature/throttling observations, and dropped/repeated frames.
- Run five-minute and 30-minute sustained sessions.
- Save a hardware-specific recommendation keyed by fingerprint.

### Gates

```bash
pnpm perf:scenario --scenario linux-720p30 --gate
pnpm perf:scenario --scenario linux-preview-recording --gate
pnpm perf:scenario --scenario linux-720p30-endurance --gate
pnpm analyze:recording -- /tmp/videorc-linux-acceptance/recording.mp4
```

### Stop conditions

- Optimization weakens correctness, privacy, or final-artifact gates.
- Performance is inferred from average FPS while latency or repeated-frame bursts fail.
- 1080p30 is enabled because a short encode starts successfully; sustained evidence
  is required.

## [P12] Phase 8 - GitHub preview, main, upstream-sync, and release channels

### Outcome

The low-power PC never needs to compile Videorc. GitHub produces validated packages
for PRs, fork main, upstream updates, tags, and manual rebuilds.

### Work

- Add reusable Linux setup/build/package workflow steps with Cargo and pnpm caches.
- Make the package job depend on Linux Rust/JS gates.
- Upload PR `.deb`, SHA-256, capability manifest, and `build-info.json` with a
  useful retention period and PR summary.
- Publish a rolling prerelease for fork `main` containing the current package and
  changes since the previous successful main build.
- Add a scheduled upstream watcher that opens or updates a sync PR instead of
  writing unreviewed upstream commits directly to the fork's main branch.
- Publish immutable tagged GitHub Releases with generated commit/PR notes plus the
  repository's user-facing changelog entry.
- Verify package download and checksum after publication.

### Gates

```bash
pnpm test:scripts
pnpm check:text-files
actionlint .github/workflows/*.yml
pnpm release:validate:linux
```

### Stop conditions

- A preview package uploads before required gates succeed.
- A workflow from an untrusted fork receives release secrets or write permissions.
- Scheduled upstream sync bypasses a visible PR and required checks.
- Release notes list hashes without explaining user-facing intent.

## [P13] Phase 9 - Clean installation and update acceptance

### Outcome

The GitHub-produced `.deb` is the artifact installed on the target PC, and a later
build proves the update path without local compilation.

### Work

- Install the downloaded `.deb` and record package/version/checksum evidence.
- Run health, hardware, capture, recording, preview, streaming, and parity smokes.
- Verify desktop entry, icon, protocol callback, file paths, permissions, and logs.
- Install a newer preview/main package and verify settings/database compatibility.
- Verify uninstall behavior preserves user recordings and handles app data as
  documented.
- Record exact rollback commands to the previous known-good `.deb`.

### Gates

```bash
pnpm smoke:packaged:linux:health
pnpm smoke:local-gates:linux
pnpm support-bundle:verify -- /tmp/videorc-linux-acceptance/support-bundle.json --linux-acceptance
```

The support-bundle path above is emitted by the smoke and is never committed.

## [P14] CI and release artifact contents

Every Linux package artifact set contains:

```text
Videorc-0.9.39-linux-amd64.deb
Videorc-0.9.39-linux-amd64.deb.sha256
build-info.json
linux-capabilities.json
THIRD-PARTY-NOTICES.txt
```

`build-info.json` records repository, commit, ref, workflow run, app/backend
versions, Node/pnpm/Rust/Electron versions, package architecture, and build time.
It does not contain runner tokens or secrets.

PR artifacts are previews, not releases. Main artifacts are prereleases. Only a
version tag produces an immutable stable/beta GitHub Release according to the
tag and changelog channel.

## [P15] Testing strategy

The pyramid is:

1. pure selection, normalization, fallback, and argument-builder unit tests;
2. protocol fixture and component tests;
3. subprocess tests against bounded synthetic PipeWire/FFmpeg inputs;
4. packaged synthetic CI smokes;
5. real GNOME Wayland portal/device smokes on the target PC;
6. final-artifact and sustained performance acceptance.

Hardware behavior is behind injectable seams so policy tests do not require real
devices. Real-device tests remain mandatory for product acceptance because mocks
cannot prove portal prompts, driver behavior, timing, or preview smoothness.

## [P16] Documentation maintenance

- `docs/linux-architecture.md` owns stable requirements and architecture.
- This file owns delivery order, stop conditions, and phase outcomes.
- `docs/linux-port-tasks.md` owns checkboxes, exact files, and test-first steps.
- `docs/acceptance/linux-app-acceptance-template.md` will own dated on-device proof.
- Generated JSON, logs, screenshots, and media live under ignored
  `docs/acceptance/artifacts/linux/2026-07-13/` (replace the example date for
  each new run).
- Each completed phase updates status and evidence without rewriting historical
  acceptance results.
