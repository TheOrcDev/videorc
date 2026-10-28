# Agent Instructions

These rules are load-bearing for Videorc work. Read this before changing code.

## Desktop Releases

When the user says "release new version", "ship an update", or asks to publish
Videorc, read `.agents/skills/videorc-release/SKILL.md` before taking release
actions. It is the entrypoint for AI-operated releases, including defaults,
ordered checkpoints, human gates, and resuming partial releases. Follow its
linked runbooks; do not invent a shorter release path from package scripts.
An explanation or edit of the release process is not permission to publish.

## Live Tests On YouTube

Only when the user explicitly asks for a real live test ("test it live",
"live lab", "go live on the test channel", "test PR #N live"), read
`.agents/skills/videorc-live-lab/SKILL.md` first. Ordinary e2e and smoke
verification never goes live. Attended runs on the owner's Mac need the
owner's go in the current session. Unattended runs on the lab machine are
allowed only when the owner's policy file allows them (`canStart` in
`scripts/live-lab/lib/policy.mjs`, plan 178); never edit or loosen
`policy.json` or `control.json`, and report a refusal instead of working
around it.

## Verification Gates

Use the smallest gate that proves the change, then run the broader gate before handing off risky work.

- TypeScript typecheck: `pnpm typecheck`
- TypeScript lint: `pnpm lint`
- TypeScript format check: `pnpm format:check`
- JS production advisory audit: `pnpm audit:js`
- Node logic tests: `pnpm test:scripts`
- Desktop unit tests: `pnpm --filter @videorc/desktop test`
- Desktop build: `pnpm build`
- Preview lifecycle probe: `pnpm probe:preview-lifecycle`
- Rust format: `cargo fmt --check --all`
- Rust advisory audit: `pnpm audit:rust` (requires `cargo install cargo-audit --locked` locally)
- Rust tests: `cargo test -p videorc-backend`
- Rust lint: `cargo clippy -p videorc-backend -- -D warnings`
- Combined dependency advisory audit: `pnpm audit:deps`
- Local smoke bundle: `pnpm smoke:local-gates`
- Linux FFmpeg provisioning (Linux x64 only): `pnpm ffmpeg:fetch:linux`
- Linux in-app encoder bridge, one backend, no host gate (Linux box only): `VIDEORC_LINUX_H264_ENCODER=openh264 VIDEORC_MATRIX_ONLY=1080p30 VIDEORC_MATRIX_PRINT_BRIDGE_DIAGNOSTICS=1 VIDEORC_SMOKE_FFMPEG_PATH=$PWD/vendor/ffmpeg/linux-x64/bin/ffmpeg node scripts/smoke-recording-matrix-app.mjs`
- Linux L1.5 named-box acceptance (both backends): `pnpm smoke:linux-encoder-acceptance` with the tester env from `docs/linux-dev-loop.md`

CI covers Rust advisory audit, Rust fmt, clippy, Rust tests, JS production advisory audit, TS format, TS lint, TS typecheck, desktop unit tests, and Node script tests. Device, preview, recording, and packaging smokes still need a local macOS environment with the right permissions.

## Recording Studio Regression Rules

- Run `pnpm smoke:recording-studio` before handing off changes that touch capture selection, preview, layout composition, recording output, FFmpeg/video encoding, audio capture, or audio sync.
- The recording-studio gate must cover desktop capture/session params, Node artifact analyzer and A/V sync tests, backend live layout/scene/recording/audio tests, the dev-app all-layout recording smoke, imported screen recording smoke, and the real ScreenCaptureKit screen recording smoke.
- It must also cover the maintained preview reliability smokes: layout/source preview liveness, backend-owned scene commits, main pump diagnostics, click/focus continuity, detached lifecycle, and detached native preview surface reattach.
- The dev-app all-layout recording smoke must inspect the finished recording artifacts with ffprobe/ffmpeg. A file-size-only recording smoke is not enough.
- Run `pnpm smoke:record-latency` for changes touching session start/stop (`start_session`, `stop_recording`, `monitor_session`), the startup or camera-cadence barriers, microphone warm-up, encoder-bridge/muxer bring-up, or recording finalization: it drives real Record/Stop cycles through the renderer via remote-control intents, verifies every artifact with the analyzer and startup-resolution gates, and reports cold/warm click→recording and click→idle percentiles against the OBS-parity budgets in `scripts/lib/record-latency-gate.mjs`. `pnpm smoke:record-latency:gate` enforces them (calibrated in `docs/acceptance/2026-09-16-record-latency-calibration.md`; part of `smoke:recording-studio` and `smoke:local-gates`). The dev app has no camera TCC grant, so the smoke seeds a screen-only scene; a real-camera run needs the packaged app.
- Run `pnpm smoke:captions-contract` and `pnpm smoke:captions-live` for changes touching live captions (`captions.rs`, the caption API client, `scripts/lib/fake-caption-service.mjs`, or caption status copy). The contract smoke drives the real debug backend against the local fake Gateway in the streaming-transcription dialect (plan 175): lease mint with `transport: "transcription"`, the `transcription-stream.start` frame with the server's `providerOptions`, binary PCM, partial/final upsert, lease handover and settlement, voice-dialect and assistant-response fallback, chunk fallback, and listen-only Buddy uploads. The live smoke proves the kill-switch path end to end through the renderer, compositor and RTMP. Never point either at a real gateway; `pnpm probe:caption-stt` is the owner-only real-model latency probe and needs `AI_GATEWAY_API_KEY` in the shell.
- Run `pnpm smoke:remote-control` for changes touching the remote-control surface (backend remote role, intents, discovery file, renderer intent executor, global shortcuts): it pairs a fake client through the real discovery file and enforces the allowlist, filter lock, intent round trips against confirmed state, debounce, and regenerate-cuts-clients. It is part of `smoke:local-gates`. Protocol doc: docs/remote-control.md.
- Run `pnpm smoke:agent-mcp` for changes touching the Agents surface (plan 209: `agent_mcp.rs`, `agent_call.rs`, `agent_look.rs`, `agent_registry.rs`, `agent_tools.rs`, the `videorc-mcp` bridge, `protocol-fixtures/agent-tools.json`, `lib/studio-actions/`, `lib/agent-surface.ts` or the `agent.intent` wiring in the Studio): it drives the dev app through the real `videorc-mcp` bridge with an isolated profile and discovery file and enforces Agents-off answers, `tools/list` equal to the catalog, the Look tools and a decodable picture, Studio round trips against confirmed state, record → marker → stop with an ffprobed artifact, `read_chat`'s viewer-marked fields against the fake chat providers, the Origin/Host/token guards, a removed agent cut, Stop closing the listener, a leak scan over every answer, and the unchanged remote allowlists; plus a step per PR B tool (plan 209 S16): headless `go_live` (refused, then `allowPartial`) to a local FFmpeg RTMP sink, captions and backgrounds, `edit_banner`, Arrange against the editor's own snap functions and the picture, chat posts and removals on the fake providers (YouTube waits for the card), Buddy, Prepare, and the Library (its delete moves into a Trash stand-in inside the run, `VIDEORC_SMOKE_TRASH_DIR`). It goes live only to that local sink, never a real channel. Never add a tool without an allowlisted projection and a leak argument (docs/agents-mcp.md). It is part of `smoke:local-gates`.
- Run `pnpm smoke:buddy-act` for changes touching Buddy's tool use (plan 209 S18 to S21: `buddy_act.rs`, the planner path in `cohost.rs`, `cohost.act`, the `/buddy` composer command and its relay, a tool's `buddy` mark in the catalog): it drives the dev app against the local planner fake and enforces `/buddy` running Buddy's calls by name with only Buddy's subset sent, a planned tool outside the subset refused before it runs, and a spoken `stop` while recording waiting for a spoken yes. It never goes live. `pnpm smoke:buddy-commands` must still pass unchanged. It is part of `smoke:local-gates`.
- Run `pnpm smoke:youtube-quota` for changes touching YouTube chat, the quota breaker (`youtube_quota.rs`), YouTube viewer or subscriber polling, YouTube OAuth connect/validate, Go Live prepare/transition, or any provider-paused copy: it drives the dev app through a full YouTube Data API outage against the local fake in `scripts/lib/fake-youtube-api.mjs` (routed with the dev-only `VIDEORC_YOUTUBE_API_BASE_URL`, refused in packaged builds) and enforces one paused notice, chat Waiting with `retryAt`, zero YouTube requests while paused, output still advancing, automatic resume after the forced expiry, Stop then Record during the outage, Go Live refused for YouTube OAuth with the stream-key copy while other destinations go live, and a terminal single-toast connect. It is part of `smoke:local-gates`. Every new YouTube Data API call must use `youtube_quota::send_attempt` for per-attempt admission and metering; only the owned reset probe may bypass the pause, and it must still count its actual attempt.
- Run `pnpm smoke:remote-lan` for changes touching Phone remote (the LAN listener and its router, pairing/handshake/signed frames in `remote_lan*.rs`, the chat/highlight projection, or `crates/videorc-backend/remote_web/`): it pairs the reference client over the machine's LAN address and enforces router isolation, token refusal, single-use pairing, signed intents, the allowlist, no renderer credential on remote sockets, per-device revoke, and port close on disable. Never add a route to the LAN router or an event to `LAN_EVENTS` without a leak argument in the PR. It is part of `smoke:local-gates`.
- Run `pnpm smoke:recording-matrix` for changes that touch encoding profiles, colorimetry, container/export, or fps handling: it records every shipping recording profile (1080p/1440p/4K × 30/60, vertical twins, the 640×360 floor) through the real app and hard-fails on missing BT.709/video-range color tags, under-spec H.264 levels, broken keyframe cadence, wrong dimensions/fps, or an unbounded A/V stop tail. Its second pass re-records 4K30 and 1080p60 with `VIDEORC_SYNTHETIC_HARD_CONTENT=1` (per-frame noise, real encoder cost) and asserts the compositor keeps rendering DURING the recording — easy synthetic content is not accepted as bridge-pressure evidence. It is part of `smoke:local-gates`.
- Run `pnpm smoke:soundboard-fixture` for changes touching the soundboard's mix (`sound_mix.rs`, `sound_player.rs`, the sounds ingredient, `SoundCommand` or the drain in `session_audio.rs`) or the sound import (`sound_store.rs`, `sound_loudness.rs`) (plan 189): it runs the real bus with a silent microphone, presses a 1 kHz fixture sound at a known sample, encodes what the Combined and Microphone muxers read, and hard-fails a missing tone, a tone more than one chunk plus 5 ms from its press, a tone in the Microphone file, clipping or an analyzer failure. It is part of `smoke:recording-studio`. Run `pnpm smoke:soundboard` (the dev app, macOS) for changes touching the soundboard's RPCs, the renderer monitor (`lib/sound-monitor.ts`) or the remote `soundPlay` intent: a press is acknowledged idle as monitor-only, lands once in a recording at the press, and with System audio on is never doubled by the monitor (that case SKIPS without the Screen Recording grant). A session with no sound pressed must keep writing byte-identical PCM (the mic-only SHA golden test).
- Run `pnpm smoke:separate-source-fixture` for changes touching `source_iso.rs`, `source_audio_tap.rs`, the compositor ISO legs (`source_iso_snapshot`, `CompositorSourceIsoOutput`), or the take/role Library columns (plan 157): it renders a camera-in-screen scene through the production publisher with the ISO legs armed (CPU and Metal), runs the real audio bus with a 440 Hz microphone and a 1 kHz system source through the production tap wiring, encodes each leg with the PCM its muxer read into a real three-file take, and hard-fails a camera inset in the Screen file, a non-camera Camera file, a missing role file, off-canvas video, duration drift, a swapped audio title, mic/system samples in the wrong file (even under the right title), or an analyzer failure. It is part of `smoke:recording-studio`. For a real-camera take recorded through the packaged app with "Separate source recordings" on, run `pnpm smoke:separate-source-take -- <combined-file>` (the dev app has no camera TCC grant).
- For native preview, source compatibility, layout liveness, or real-device capture changes, run `pnpm smoke:recording-studio:devices` when the local macOS host has the required screen/camera/mic permissions. If that cannot run, say why and run the closest focused native-preview probe or smoke.
- For audio sync changes, keep `pnpm test:scripts` and a final-artifact A/V analysis in the verification set. Do not rely on manual playback alone.
- Do not hand off recording-studio work with only typecheck/lint unless the change is docs-only or the relevant smoke is explicitly blocked.
- Changes that touch the Linux arm of the recording path (`cfg(target_os = "linux")` in `recording.rs`, the VAAPI probe, render-node policy, or the Linux FFmpeg args) need a run of the direct matrix command on the named Linux box from `docs/linux-port-plan.md`, or an explicit statement of why that box could not run it. macOS cannot compile that arm; the `Linux` CI job is the compile gate, not the behaviour gate. Never probe a render node the box has quarantined.

## Native Preview Rules

- Production macOS preview is the detached native CAMetalLayer path. MJPEG/JPEG preview routes are fallback or debug paths only.
- The current Windows production presenter is the uncompressed, latest-wins BMP Electron proof surface documented in `docs/windows-port-plan.md`. It may report a healthy lifecycle only after its first-frame and source-liveness contracts pass, and it must remain identified as `electron-proof-surface` / `electron-browser-window`; it must never claim native CAMetalLayer transport or backing. Production PNG requests remain a transport bug.
- Do not silently downgrade a session that claims native preview. If native CAMetalLayer cannot run on macOS, surface the fallback reason in status, diagnostics, or health copy. On Windows, surface proof-presenter startup and source stalls without mislabeling the supported proof transport as native.
- Probe before merging preview changes. At minimum run the relevant native preview tests and use the smoke/probe command that exercises the touched path.
- For detached preview window lifecycle, toggle, close/reopen, placement ownership, frame-polling suppression, or proof-surface teardown changes, run `pnpm probe:preview-lifecycle`; add `pnpm probe:preview-window` when placement or move/resize behavior is touched.
- `PreviewSurfaceBounds` has mirrors in Rust protocol, shared TS types, native host/helper protocol, and normalization/comparison code. Any field change must preserve all mirrors and must include a regression test proving fields survive normalization and helper serialization.
- Stacking fields (`orderAboveWindowId`, `elevated`) are required for detached preview-window ordering. Dropping them reintroduces the preview-over-everything bug.

## Process And Script Rules

- Do not use broad process scans such as `pgrep -f` to clean up app children. Only reap app-owned PIDs recorded by Videorc.
- Windows async/process tests must use explicit readiness channels or spawn-boundary evidence. Do not use fixed sleeps, temporary files, or shell-wrapped grandchildren as lifecycle handshakes. Give child cleanup a bounded deadline and kill/reap the owned child before failing.
- Before handing off a change to Windows async/process tests, run the affected filters at least 25 times and the full Windows Rust suite three times from PowerShell 7. A single green run is not stability evidence.
- Keep scratch probes out of the committed tree unless they are promoted into maintained smoke/probe scripts. If a temporary script is useful, put it under `scripts/` with a clear name, testable assumptions, and a package script.
- Do not commit secrets, local tokens, app data, recordings, or generated media evidence unless a doc explicitly asks for a tiny fixture.
- The worktree may contain user changes. Stage only files you intentionally changed for the current slice.

## Style

- Match existing TypeScript and Rust style. Prefer small pure helpers for behavior that needs tests.
- Keep frontend controls dense and work-focused. Use the existing component system and icon set.
- Prefer explicit status and diagnostics over silent fallbacks.
